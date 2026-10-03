using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Application.Sta;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>
/// Work runs, as the platform sees them. Execution truth stays in STA Core —
/// this service enforces who may start/see/control what, then relays to the
/// STA Local API (one canonical execution path: platform → STA Core → runtime).
/// </summary>
public class RunService(
    IAppDbContext db,
    ICurrentUserService current,
    KnowledgeService knowledges,
    AuditService audit,
    IStaCoreClient sta)
{
    public async Task<RunListDto> StartAsync(StartRunRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var knowledge = await db.Knowledges.FirstOrDefaultAsync(k => k.OrganizationId == actor.OrganizationId && k.Name == request.KnowledgeName, ct)
            ?? throw AppException.NotFound($"ไม่พบ Knowledge \"{request.KnowledgeName}\" ในแพลตฟอร์ม");
        if (!await knowledges.IsMemberAsync(actor, knowledge.Id, ct))
            throw AppException.Forbidden("คุณไม่ได้เป็นสมาชิกของ Knowledge นี้");
        if (!knowledge.RegisteredOnThisMachine)
            throw new AppException($"Knowledge \"{knowledge.Name}\" ยังไม่ลงทะเบียนบนเครื่อง STA Core นี้");

        var result = await sta.CreateRunAsync(knowledge.Name, request.Module, request.CommandText, ct)
            ?? throw new AppException("STA Core ไม่ตอบสนอง — ตรวจว่า `sta start` ทำงานอยู่", 502);
        var run = result.Run ?? throw new AppException("STA Core ปฏิเสธคำสั่ง — ดู reason จาก STA", 502);

        var mirror = new WorkRun
        {
            OrganizationId = actor.OrganizationId,
            StaRunId = run.RunId,
            KnowledgeId = knowledge.Id,
            Module = run.Module,
            CreatedById = actor.UserId,
            LastStatus = run.Status,
            LastStatusReason = run.StatusReason,
            CreatedAt = ToUtc(run.CreatedAt),
            UpdatedAt = DateTime.UtcNow,
        };
        db.WorkRuns.Add(mirror);
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "run.started", actor, objectType: "sta_run", objectId: run.RunId,
            knowledge: knowledge.Name, module: run.Module, detail: new { command = request.CommandText }, ct: ct);

        return new RunListDto(run.RunId, knowledge.Id, knowledge.Name, run.Module, run.Status, run.StatusReason,
            run.HumanGates.Count(g => g.ResolvedAt is null), mirror.CreatedAt, mirror.UpdatedAt, actor.Name);
    }

    public async Task<List<RunListDto>> ListAsync(string? status, string? knowledgeName, string? module, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var visibleIds = await VisibleKnowledgeIdsAsync(actor, ct);
        var mirrors = await db.WorkRuns
            .Include(r => r.Knowledge)
            .Include(r => r.CreatedBy)
            .Where(r => r.OrganizationId == actor.OrganizationId && visibleIds.Contains(r.KnowledgeId))
            .OrderByDescending(r => r.UpdatedAt).ToListAsync(ct);
        if (knowledgeName is not null) mirrors = mirrors.Where(r => r.Knowledge.Name == knowledgeName).ToList();
        if (module is not null) mirrors = mirrors.Where(r => r.Module == module).ToList();
        if (status is not null) mirrors = mirrors.Where(r => r.LastStatus == status).ToList();

        // Live status from STA wins over the mirror; an offline STA still renders the mirror.
        var live = new Dictionary<string, StaRunSummary>();
        try
        {
            var staRuns = await sta.ListRunsAsync(ct: ct);
            live = staRuns.ToDictionary(r => r.RunId, r => r);
        }
        catch { /* offline */ }

        return mirrors.Select(r =>
        {
            var staRun = live.GetValueOrDefault(r.StaRunId);
            return new RunListDto(
                r.StaRunId, r.KnowledgeId, r.Knowledge.Name, r.Module,
                staRun?.Status ?? r.LastStatus, staRun?.StatusReason ?? r.LastStatusReason,
                staRun?.OpenGates ?? 0,
                r.CreatedAt, staRun is not null ? RunService.ToUtc(staRun.UpdatedAt) : r.UpdatedAt,
                r.CreatedBy?.Name);
        }).ToList();
    }

    public async Task<StaRunDetail> GetAsync(string staRunId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var mirror = await RequireVisibleRunAsync(actor, staRunId, ct);
        var detail = await sta.GetRunAsync(staRunId, ct)
            ?? throw new AppException("STA Core ไม่ตอบสนอง — ตรวจว่า `sta start` ทำงานอยู่", 502);
        return detail;
    }

    /// <summary>The aggregate diff of the run's work — human review aid; visibility follows the run's Knowledge.</summary>
    public async Task<StaRunDiff> GetDiffAsync(string staRunId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        await RequireVisibleRunAsync(actor, staRunId, ct);
        return await sta.GetRunDiffAsync(staRunId, ct)
            ?? throw new AppException("STA Core ไม่ตอบสนอง — ตรวจว่า `sta start` ทำงานอยู่", 502);
    }

    /// <summary>The git commands the human runs themselves — STA never pushes/merges, and neither does the platform.</summary>
    public async Task<StaPrepareCommit> GetPrepareCommitAsync(string staRunId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        await RequireVisibleRunAsync(actor, staRunId, ct);
        return await sta.GetPrepareCommitAsync(staRunId, ct)
            ?? throw new AppException("STA Core ไม่ตอบสนอง — ตรวจว่า `sta start` ทำงานอยู่", 502);
    }

    public async Task<StaRunDetail> ControlAsync(string staRunId, string action, bool? force, string? note, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        await RequireVisibleRunAsync(actor, staRunId, ct);
        var result = action switch
        {
            "pause" => await sta.PauseAsync(staRunId, ct),
            "resume" => await sta.ResumeAsync(staRunId, ct),
            "stop" => await sta.StopAsync(staRunId, force == true, ct),
            _ => throw new AppException($"action ไม่รู้จัก: {action}"),
        } ?? throw new AppException("STA Core ไม่ตอบสนอง", 502);
        await audit.WriteAndSaveAsync(ActorType.User, $"run.{action}", actor, objectType: "sta_run", objectId: staRunId, ct: ct);
        return result;
    }

    public async Task<StaRunDetail> ReviewAsync(string staRunId, bool approve, string? note, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var mirror = await RequireVisibleRunAsync(actor, staRunId, ct);
        var result = (approve
            ? await sta.ApproveAsync(staRunId, actor.Name, note, ct)
            : await sta.SendBackAsync(staRunId, actor.Name, note ?? "sent back", ct))
            ?? throw new AppException("STA Core ไม่ตอบสนอง", 502);
        await audit.WriteAndSaveAsync(ActorType.User, approve ? "run.approved" : "run.sent_back", actor, objectType: "sta_run",
            objectId: staRunId, knowledge: mirror.Knowledge.Name, module: mirror.Module, detail: new { note }, ct: ct);
        return result;
    }

    public async Task<WorkRun> RequireVisibleRunAsync(CurrentUser actor, string staRunId, CancellationToken ct = default)
    {
        var mirror = await db.WorkRuns.Include(r => r.Knowledge)
            .FirstOrDefaultAsync(r => r.StaRunId == staRunId && r.OrganizationId == actor.OrganizationId, ct)
            ?? throw AppException.NotFound($"ไม่พบ run {staRunId}");
        if (!await knowledges.IsMemberAsync(actor, mirror.KnowledgeId, ct))
            throw AppException.Forbidden("คุณไม่ได้เป็นสมาชิกของ Knowledge ของ run นี้");
        return mirror;
    }

    private async Task<List<int>> VisibleKnowledgeIdsAsync(CurrentUser actor, CancellationToken ct)
        => actor.IsOrgAdmin
            ? await db.Knowledges.Where(k => k.OrganizationId == actor.OrganizationId).Select(k => k.Id).ToListAsync(ct)
            : await db.KnowledgeMembers.Where(m => m.UserId == actor.UserId).Select(m => m.KnowledgeId).ToListAsync(ct);

    internal static DateTime ToUtc(long epochMs) => DateTimeOffset.FromUnixTimeMilliseconds(epochMs).UtcDateTime;
}
