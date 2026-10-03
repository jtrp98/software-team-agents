using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Application.Sta;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>The team workflow view (spec §19): everyone authorized sees where the work stands and who a gate waits on — actions still follow roles.</summary>
public class TeamService(IAppDbContext db, ICurrentUserService current, KnowledgeService knowledges, IStaCoreClient sta)
{
    private static readonly IReadOnlyDictionary<string, string> StageRole = new Dictionary<string, string>
    {
        ["business-analyst"] = "BA",
        ["system-analyst"] = "SA",
        ["project-manager"] = "PM",
        ["test-planner"] = "PM",
        ["uxui-designer"] = "UX/UI",
        ["backend-engineer"] = "Dev",
        ["frontend-engineer"] = "Dev",
        ["reviewer"] = "Reviewer",
        ["qa-engineer"] = "QA",
        ["security"] = "Security",
        ["devops"] = "DevOps",
    };

    public async Task<List<TeamRowDto>> ViewAsync(int knowledgeId, string? module, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        await knowledges.RequireVisibleAsync(actor, knowledgeId, ct);
        var staRuns = await sta.ListRunsAsync(module: module, knowledge: null, ct: ct);
        var platformRunIds = await db.WorkRuns
            .Where(r => r.OrganizationId == actor.OrganizationId && r.KnowledgeId == knowledgeId)
            .Select(r => r.StaRunId).ToHashSetAsync(ct);

        var waitingOn = new Dictionary<string, string>();
        foreach (var summary in staRuns.Where(r => platformRunIds.Contains(r.RunId) && r.OpenGates > 0))
        {
            var detail = await sta.GetRunAsync(summary.RunId, ct);
            if (detail is null) continue;
            var openGates = detail.Run.HumanGates.Where(g => g.ResolvedAt is null).ToList();
            if (openGates.Count == 0) continue;
            var platformGate = await db.HumanGates
                .Include(g => g.Assignee)
                .Where(g => g.StaRunId == summary.RunId && g.Status != GateStatus.Answered
                            && g.Status != GateStatus.Cancelled && g.Status != GateStatus.Superseded)
                .OrderByDescending(g => g.Id).FirstOrDefaultAsync(ct);
            var who = platformGate?.Assignee?.Name
                ?? (platformGate?.RequiredRole is null ? "creator" : platformGate.RequiredRole);
            foreach (var gate in openGates) waitingOn[gate.Id] = who;
        }

        var rows = new List<TeamRowDto>();
        foreach (var summary in staRuns.Where(r => platformRunIds.Contains(r.RunId)))
        {
            if (module is not null && summary.Module != module) continue;
            var detail = await sta.GetRunAsync(summary.RunId, ct);
            var tasks = detail?.Run.Snapshot?.Tasks ?? [];
            foreach (var task in tasks)
            {
                rows.Add(new TeamRowDto(
                    task.TaskId, task.Phase, task.Status, task.Stage,
                    task.Stage is not null && StageRole.TryGetValue(task.Stage, out var role) ? role : null,
                    task.Status is "WAITING_FOR_HUMAN" or "BLOCKED" ? PickWaitingOn(detail!.Run.HumanGates, waitingOn) : null,
                    summary.RunId));
            }
        }
        return rows;
    }

    private static string? PickWaitingOn(List<StaHumanGate> gates, Dictionary<string, string> waitingOn)
    {
        foreach (var gate in gates.Where(g => g.ResolvedAt is null))
            if (waitingOn.TryGetValue(gate.Id, out var who)) return who;
        return waitingOn.Count > 0 ? waitingOn.Values.First() : null;
    }
}
