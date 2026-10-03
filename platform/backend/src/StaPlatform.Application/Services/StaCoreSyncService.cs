using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using StaPlatform.Application.Common;
using StaPlatform.Application.Sta;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>
/// One sync pass between STA Core and the platform: mirror run statuses into
/// work_runs, auto-create role-owned platform gates from a run's open STA
/// gates, close platform gates answered directly in STA, and fold runtime
/// events into runtime_usage. Deterministic and idempotent — safe to run on a
/// timer.
/// </summary>
public class StaCoreSyncService(
    IAppDbContext db,
    IStaCoreClient sta,
    GateService gates,
    PoolService pools,
    ILogger<StaCoreSyncService> logger)
{
    private static readonly IReadOnlySet<string> WatchStatuses = new HashSet<string>
    { "WAITING_FOR_HUMAN", "READY_FOR_REVIEW", "PAUSED_RUNTIME_EXHAUSTED", "PAUSED" };

    public async Task SyncOnceAsync(CancellationToken ct = default)
    {
        var orgId = await db.Organizations.Select(o => o.Id).FirstOrDefaultAsync(ct);
        if (orgId == 0) return;

        IReadOnlyList<StaRunSummary> summaries;
        try
        {
            summaries = await sta.ListRunsAsync(ct: ct);
        }
        catch (Exception error)
        {
            logger.LogDebug(error, "STA Core is not reachable; sync skipped");
            return;
        }

        var knowledgeByName = await db.Knowledges.Where(k => k.OrganizationId == orgId)
            .ToDictionaryAsync(k => k.Name, k => k, ct);
        var knownRunIds = await db.WorkRuns.Where(r => r.OrganizationId == orgId).Select(r => r.StaRunId).ToHashSetAsync(ct);

        foreach (var summary in summaries)
        {
            var runId = summary.RunId;
            var mirror = await db.WorkRuns.FirstOrDefaultAsync(r => r.StaRunId == runId, ct);
            if (mirror is null)
            {
                if (!knowledgeByName.TryGetValue(summary.Knowledge, out var knowledge)) continue;
                mirror = new WorkRun
                {
                    OrganizationId = orgId,
                    StaRunId = runId,
                    KnowledgeId = knowledge.Id,
                    Module = summary.Module,
                    CreatedById = null,
                    LastStatus = summary.Status,
                    LastStatusReason = summary.StatusReason,
                    CreatedAt = RunService.ToUtc(summary.CreatedAt),
                    UpdatedAt = DateTime.UtcNow,
                };
                db.WorkRuns.Add(mirror);
            }
            mirror.LastStatus = summary.Status;
            mirror.LastStatusReason = summary.StatusReason;
            mirror.UpdatedAt = DateTime.UtcNow;

            StaRunDetail? detail = null;
            if (WatchStatuses.Contains(summary.Status) || knownRunIds.Contains(runId))
            {
                try { detail = await sta.GetRunAsync(runId, ct); }
                catch { /* the run may be busy; next pass */ }
            }

            if (detail is not null)
            {
                await SyncGatesAsync(knowledgeByName, mirror, detail, ct);
                await SyncUsageAsync(orgId, mirror, detail, ct);
            }
        }
        await db.SaveChangesAsync(ct);
    }

    private async Task SyncGatesAsync(Dictionary<string, Knowledge> knowledgeByName, WorkRun mirror, StaRunDetail detail, CancellationToken ct)
    {
        var staGates = detail.Run.HumanGates;
        foreach (var staGate in staGates.Where(g => g.ResolvedAt is null))
        {
            var key = $"{mirror.StaRunId}:{staGate.Id}";
            if (await db.HumanGates.AnyAsync(g => g.StaGateKey == key, ct)) continue;
            if (!knowledgeByName.TryGetValue(mirror.Knowledge.Name, out var knowledge)) continue;
            var created = await gates.EnsureFromStaRunGateAsync(knowledge, mirror.Module, mirror.StaRunId, staGate, mirror.CreatedById, ct);
            if (created is not null)
                await gates.SupersedeEarlierAsync(knowledge.Id, mirror.Module, created.GateType, key, ct);
        }
        foreach (var staGate in staGates.Where(g => g.ResolvedAt is not null))
        {
            await gates.MarkAnsweredByStaAsync($"{mirror.StaRunId}:{staGate.Id}", ct);
        }
    }

    private async Task SyncUsageAsync(int orgId, WorkRun mirror, StaRunDetail detail, CancellationToken ct)
    {
        var fresh = detail.RuntimeEvents
            .Where(e => e.At > mirror.LastSyncedEventAt && e.Event is "success" or "failure")
            .ToList();
        foreach (var entry in fresh)
        {
            await pools.RecordUsageAsync(orgId, entry.RuntimeId, mirror.StaRunId, entry.Role,
                entry.Event, entry.FailureClass, entry.Detail, ct);
        }
        if (fresh.Count > 0) mirror.LastSyncedEventAt = fresh.Max(e => e.At);
    }
}
