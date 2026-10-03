using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Application.Sta;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>
/// Role-owned Human Gates (spec §11–§21). Routing is data-driven
/// (gate_policies), answering is authorized server-side against effective
/// roles, concurrency-safe (rowversion), and every answer records the acting
/// role. A gate blocks only the work it names; answering it resumes that work
/// automatically.
/// </summary>
public class GateService(
    IAppDbContext db,
    ICurrentUserService current,
    AssignmentService assignments,
    KnowledgeService knowledges,
    AuditService audit,
    IStaCoreClient sta,
    ILogger<GateService> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly GateStatus[] OpenStatuses = [GateStatus.Open, GateStatus.Assigned, GateStatus.Waiting];

    /// <summary>Engine approval type → gate type — the one integration mapping; the required role comes from gate_policies.</summary>
    private static readonly IReadOnlyDictionary<string, string> EngineApprovalGateType = new Dictionary<string, string>
    {
        ["requirement-interview"] = GateTypes.RequirementDecision,
        ["schema-confirmation"] = GateTypes.ArchitectureDecision,
        ["uxui-signoff"] = GateTypes.UxDecision,
        ["uxui-ack"] = GateTypes.UxDecision,
        ["review-failure"] = GateTypes.DevDecision,
        ["qa-failure"] = GateTypes.QaDecision,
        ["security-risk"] = GateTypes.SecurityDecision,
        ["deploy"] = GateTypes.ReleaseDecision,
        ["ba-signoff"] = GateTypes.RequirementDecision,
        ["ba-ack"] = GateTypes.RequirementDecision,
        ["sa-signoff"] = GateTypes.ArchitectureDecision,
        ["sa-ack"] = GateTypes.ArchitectureDecision,
        ["dev-signoff"] = GateTypes.DevDecision,
        ["dev-ack"] = GateTypes.DevDecision,
    };

    public static string? GateTypeForEngineApproval(string approvalType)
        => EngineApprovalGateType.GetValueOrDefault(approvalType.ToLowerInvariant());

    // ───────────────────────── queries ─────────────────────────

    public async Task<List<GateCardDto>> MyGatesAsync(CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var memberKnowledgeIds = await db.KnowledgeMembers.Where(m => m.UserId == actor.UserId).Select(m => m.KnowledgeId).ToListAsync(ct);
        var query = db.HumanGates
            .Include(g => g.Knowledge)
            .Include(g => g.Assignee)
            .Include(g => g.AnsweredBy)
            .Where(g => g.Knowledge.OrganizationId == actor.OrganizationId && OpenStatuses.Contains(g.Status));
        if (!actor.IsOrgAdmin) query = query.Where(g => memberKnowledgeIds.Contains(g.KnowledgeId));
        var gates = await query.OrderByDescending(g => g.CreatedAt).ToListAsync(ct);

        var roleCache = new Dictionary<(int KnowledgeId, string? Module), HashSet<string>>();
        var result = new List<GateCardDto>();
        foreach (var gate in gates)
        {
            var canAnswer = await CanAnswerAsync(actor, gate, roleCache, ct);
            result.Add(ToCard(gate, canAnswer));
        }
        return result;
    }

    public async Task<object> CountsByRoleAsync(CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var memberKnowledgeIds = await db.KnowledgeMembers.Where(m => m.UserId == actor.UserId).Select(m => m.KnowledgeId).ToListAsync(ct);
        var query = db.HumanGates
            .Where(g => g.Knowledge.OrganizationId == actor.OrganizationId && OpenStatuses.Contains(g.Status) && g.RequiredRole != null);
        if (!actor.IsOrgAdmin) query = query.Where(g => memberKnowledgeIds.Contains(g.KnowledgeId));
        var gates = await query.Select(g => new { g.KnowledgeId, g.Module, g.RequiredRole }).ToListAsync(ct);
        var myAssignments = await db.RoleAssignments.Where(a => a.UserId == actor.UserId)
            .Select(a => new { a.Role, a.KnowledgeId, a.Module }).ToListAsync(ct);

        var counts = new Dictionary<string, int>();
        foreach (var gate in gates)
        {
            var holds = myAssignments.Any(a => a.Role == gate.RequiredRole
                && (a.KnowledgeId == null || a.KnowledgeId == gate.KnowledgeId)
                && (a.Module == null || (gate.Module != null && a.Module == gate.Module)));
            if (!holds) continue;
            counts[gate.RequiredRole!] = counts.TryGetValue(gate.RequiredRole!, out var n) ? n + 1 : 1;
        }
        return counts.OrderBy(kv => kv.Key).ToDictionary(kv => kv.Key, kv => kv.Value);
    }

    public async Task<GateDetailDto> GetAsync(int gateId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var gate = await db.HumanGates
            .Include(g => g.Knowledge)
            .Include(g => g.Assignee)
            .Include(g => g.AnsweredBy)
            .FirstOrDefaultAsync(g => g.Id == gateId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Gate {gateId}");
        if (!actor.IsOrgAdmin && !await db.KnowledgeMembers.AnyAsync(m => m.KnowledgeId == gate.KnowledgeId && m.UserId == actor.UserId, ct))
            throw AppException.Forbidden("คุณไม่ได้เป็นสมาชิกของ Knowledge นี้");
        var canAnswer = await CanAnswerAsync(actor, gate, new(), ct);
        return new GateDetailDto(ToCard(gate, canAnswer), gate.ContextJson, gate.BlockedRefsJson, gate.RoutingMode.ToString());
    }

    // ───────────────────────── lifecycle ─────────────────────────

    public async Task<GateCardDto> CreateAsync(CreateGateRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var knowledge = await knowledges.RequireVisibleAsync(actor, request.KnowledgeId, ct);

        // One concept, one source of truth: the required role comes from the gate_policies table.
        var requiredRole = (await db.GatePolicies.FirstOrDefaultAsync(p => p.GateType == request.GateType, ct))?.RequiredRole
            ?? (request.GateType == GateTypes.Operational ? null
                : throw new AppException($"gate_type ไม่รู้จัก: {request.GateType} (ดู /api/gate-policies)"));

        if (request.StaGateKey is not null)
        {
            var existing = await db.HumanGates.FirstOrDefaultAsync(
                g => g.StaGateKey == request.StaGateKey && OpenStatuses.Contains(g.Status), ct);
            if (existing is not null) return ToCard(existing, false);
        }

        var routing = ParseRouting(request.RoutingMode);
        int? assigneeId;
        if (routing == GateRoutingMode.SpecificAssignee && request.AssigneeId is not null)
        {
            assigneeId = request.AssigneeId;
        }
        else if (requiredRole is null)
        {
            assigneeId = request.AssigneeId; // operational gates: the run's creator, chosen by the caller
        }
        else
        {
            var eligible = await assignments.UsersWithRoleAsync(actor.OrganizationId, requiredRole, request.KnowledgeId, request.Module, ct);
            assigneeId = routing == GateRoutingMode.PrimaryThenBackup ? eligible.FirstOrDefault().User?.Id : eligible.FirstOrDefault().User?.Id;
            if (assigneeId is null && routing == GateRoutingMode.PrimaryThenBackup)
                assigneeId = null; // nobody primary: the gate waits, visible to admins for reassignment
        }

        var now = DateTime.UtcNow;
        var gate = new HumanGate
        {
            OrganizationId = actor.OrganizationId,
            KnowledgeId = knowledge.Id,
            Module = request.Module,
            GateType = request.GateType,
            RequiredRole = requiredRole,
            RoutingMode = routing,
            AssigneeId = assigneeId,
            Status = assigneeId is null ? GateStatus.Open : GateStatus.Assigned,
            Question = request.Question,
            ContextJson = request.ContextJson,
            AiAnalysis = request.AiAnalysis,
            OptionsJson = request.Options is { Count: > 0 } ? JsonSerializer.Serialize(request.Options, Json) : null,
            BlockedRefsJson = request.StaRunId is null ? null : JsonSerializer.Serialize(new[] { new { kind = "sta_run", runId = request.StaRunId } }, Json),
            StaGateKey = request.StaGateKey,
            StaRunId = request.StaRunId,
            CreatedByType = ActorType.User,
            CreatedById = actor.UserId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.HumanGates.Add(gate);
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "gate.created", actor, objectType: "gate", objectId: gate.DisplayId,
            knowledge: knowledge.Name, module: request.Module, detail: new { request.GateType, requiredRole, routing = routing.ToString() }, ct: ct);
        await audit.WriteAndSaveAsync(ActorType.System, "gate.routed", actor, objectType: "gate", objectId: gate.DisplayId,
            knowledge: knowledge.Name, module: request.Module, detail: new { assigneeId, status = gate.Status.ToString() }, ct: ct);
        return ToCard(gate, await CanAnswerAsync(actor, gate, new(), ct));
    }

    /// <summary>The answer path. Wrong role → 403 (never just a disabled button, spec §16); concurrent answer → 409; the decision unblocks the linked run automatically.</summary>
    public async Task<GateCardDto> AnswerAsync(int gateId, AnswerGateRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var gate = await db.HumanGates.Include(g => g.Knowledge).Include(g => g.Assignee)
            .FirstOrDefaultAsync(g => g.Id == gateId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Gate {gateId}");
        if (!OpenStatuses.Contains(gate.Status))
            throw AppException.Conflict("Gate already answered");
        if (gate.Knowledge.OrganizationId != actor.OrganizationId)
            throw AppException.Forbidden("Gate นี้อยู่คนละองค์กร");
        if (gate.StaApprovalRequestId is not null && request.Approved is null && request.Choice is null)
            throw new AppException("gate นี้ถือคำถามของ engine — ต้องตอบ approve/reject หรือเลือกตัวเลือกที่ AI เสนอ");

        var actingRole = await AuthorizeAnswerAsync(actor, gate, ct);

        var decision = new
        {
            approved = request.Approved,
            choice = request.Choice,
            comment = request.Comment,
            source = "platform",
        };
        gate.Status = GateStatus.Answered;
        gate.AnsweredAt = DateTime.UtcNow;
        gate.AnsweredById = actor.UserId;
        gate.ActingRole = actingRole;
        gate.DecisionJson = JsonSerializer.Serialize(decision, Json);
        gate.UpdatedAt = DateTime.UtcNow;

        try
        {
            await db.SaveChangesAsync(ct); // rowversion (xmin) on Postgres: a racing answer throws here.
        }
        catch (DbUpdateConcurrencyException)
        {
            throw AppException.Conflict("Gate already answered");
        }

        await audit.WriteAndSaveAsync(ActorType.User, "gate.answered", actor, actingRole, objectType: "gate",
            objectId: gate.DisplayId, knowledge: gate.Knowledge.Name, module: gate.Module,
            detail: new { decision.approved, decision.choice, comment = decision.comment }, ct: ct);

        await DispatchToStaAsync(gate, request, actor, ct);
        return ToCard(gate, false);
    }

    public async Task<GateCardDto> ReassignAsync(int gateId, int newAssigneeId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var gate = await db.HumanGates.Include(g => g.Knowledge).FirstOrDefaultAsync(g => g.Id == gateId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Gate {gateId}");
        if (!OpenStatuses.Contains(gate.Status)) throw AppException.Conflict("Gate already answered");
        if (!actor.IsOrgAdmin && !await knowledges.IsKnowledgeAdminAsync(actor, gate.KnowledgeId, ct))
            throw AppException.Forbidden("จัด Gate ใหม่ได้เฉพาะผู้ดูแล");
        _ = await db.Users.FirstOrDefaultAsync(u => u.Id == newAssigneeId, ct)
            ?? throw AppException.NotFound($"ไม่พบผู้ใช้ {newAssigneeId}");

        gate.AssigneeId = newAssigneeId;
        gate.Status = GateStatus.Assigned;
        gate.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "gate.reassigned", actor, objectType: "gate", objectId: gate.DisplayId,
            knowledge: gate.Knowledge.Name, module: gate.Module, detail: new { newAssigneeId }, ct: ct);
        return ToCard(gate, false);
    }

    public async Task CancelAsync(int gateId, string? reason, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var gate = await db.HumanGates.Include(g => g.Knowledge).FirstOrDefaultAsync(g => g.Id == gateId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Gate {gateId}");
        if (!OpenStatuses.Contains(gate.Status)) throw AppException.Conflict("Gate already answered");
        if (!actor.IsOrgAdmin && !await knowledges.IsKnowledgeAdminAsync(actor, gate.KnowledgeId, ct))
            throw AppException.Forbidden("ยกเลิก Gate ได้เฉพาะผู้ดูแล");
        gate.Status = GateStatus.Cancelled;
        gate.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "gate.cancelled", actor, objectType: "gate", objectId: gate.DisplayId,
            knowledge: gate.Knowledge.Name, module: gate.Module, detail: new { reason }, ct: ct);
    }

    // ───────────────────────── STA sync helpers (used by the sync worker) ─────────────────────────

    /// <summary>Creates the platform-side mirror of a STA Core run gate (or returns the existing one). Dedupe key: "{staRunId}:{staGateId}".</summary>
    public async Task<HumanGate?> EnsureFromStaRunGateAsync(
        Knowledge knowledge, string? module, string staRunId, StaHumanGate staGate, int? runCreatorId, CancellationToken ct = default)
    {
        var key = $"{staRunId}:{staGate.Id}";
        var existing = await db.HumanGates.FirstOrDefaultAsync(g => g.StaGateKey == key, ct);
        if (existing is not null) return existing;

        var (gateType, requiredRole, routing) = MapStaKind(staGate.Kind, runCreatorId);
        var now = DateTime.UtcNow;
        var gate = new HumanGate
        {
            OrganizationId = knowledge.OrganizationId,
            KnowledgeId = knowledge.Id,
            Module = module,
            GateType = gateType,
            RequiredRole = requiredRole,
            RoutingMode = routing,
            AssigneeId = routing == GateRoutingMode.SpecificAssignee ? runCreatorId : null,
            Status = routing == GateRoutingMode.SpecificAssignee && runCreatorId is not null ? GateStatus.Assigned : GateStatus.Open,
            Question = staGate.Reason is { Length: > 0 } ? staGate.Reason : $"STA run {staRunId} หยุดรอคนตัดสินใจ ({staGate.Kind})",
            ContextJson = JsonSerializer.Serialize(new { staRunId, staGateKind = staGate.Kind, staGateId = staGate.Id }, Json),
            BlockedRefsJson = JsonSerializer.Serialize(new[] { new { kind = "sta_run", runId = staRunId } }, Json),
            StaGateKey = key,
            StaRunId = staRunId,
            CreatedByType = ActorType.Ai,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.HumanGates.Add(gate);
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.Ai, "gate.created", actingRole: "sta-core", objectType: "gate", objectId: gate.DisplayId,
            knowledge: knowledge.Name, module: module, detail: new { staGate.Kind, auto = true }, ct: ct);
        return gate;
    }

    /// <summary>
    /// Creates the platform gate for one pending ENGINE approval (requirement
    /// interview, QA failure, deploy…), routed to the role owner via
    /// gate_policies. Answering it relays the decision back into the engine.
    /// </summary>
    public async Task<HumanGate?> EnsureFromEngineApprovalAsync(
        Knowledge knowledge, string? module, string staRunId, StaEngineApproval approval, int? runCreatorId, CancellationToken ct = default)
    {
        var key = $"{staRunId}:apr:{approval.RequestId}";
        var existing = await db.HumanGates.FirstOrDefaultAsync(g => g.StaGateKey == key, ct);
        if (existing is not null) return existing;

        var gateType = GateTypeForEngineApproval(approval.Type);
        if (gateType is null) return null; // unknown engine approval type: the run-level gate still covers it

        var requiredRole = (await db.GatePolicies.FirstOrDefaultAsync(p => p.GateType == gateType, ct))?.RequiredRole;
        var now = DateTime.UtcNow;
        var gate = new HumanGate
        {
            OrganizationId = knowledge.OrganizationId,
            KnowledgeId = knowledge.Id,
            Module = module,
            GateType = gateType,
            RequiredRole = requiredRole,
            RoutingMode = GateRoutingMode.AnyAuthorized,
            Status = GateStatus.Open,
            Question = approval.Reason is { Length: > 0 } ? approval.Reason : $"engine approval {approval.Type} รอคำตอบ (task {approval.TaskId})",
            ContextJson = JsonSerializer.Serialize(new { staRunId, staTaskId = approval.TaskId, staApprovalType = approval.Type, from = approval.From, to = approval.To }, Json),
            BlockedRefsJson = JsonSerializer.Serialize(new[] { new { kind = "engine_approval", runId = staRunId, requestId = approval.RequestId, taskId = approval.TaskId } }, Json),
            StaGateKey = key,
            StaRunId = staRunId,
            StaApprovalTaskId = approval.TaskId,
            StaApprovalRequestId = approval.RequestId,
            CreatedByType = ActorType.Ai,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.HumanGates.Add(gate);
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.Ai, "gate.created", actingRole: "sta-core", objectType: "gate", objectId: gate.DisplayId,
            knowledge: knowledge.Name, module: module, detail: new { engineApproval = approval.Type, gateType, requiredRole, auto = true }, ct: ct);
        return gate;
    }

    /// <summary>Real approval gates took over a run's waiting state — the creator-routed operational stand-in retires.</summary>
    public async Task SupersedeRunOperationalAsync(int knowledgeId, string staRunId, CancellationToken ct = default)
    {
        var stale = await db.HumanGates
            .Where(g => g.KnowledgeId == knowledgeId && g.StaRunId == staRunId && g.GateType == GateTypes.Operational
                        && OpenStatuses.Contains(g.Status))
            .ToListAsync(ct);
        foreach (var gate in stale)
        {
            gate.Status = GateStatus.Superseded;
            gate.UpdatedAt = DateTime.UtcNow;
        }
        if (stale.Count > 0) await db.SaveChangesAsync(ct);
    }

    public async Task MarkAnsweredByStaAsync(string staGateKey, CancellationToken ct = default)
    {
        var gate = await db.HumanGates.FirstOrDefaultAsync(g => g.StaGateKey == staGateKey && OpenStatuses.Contains(g.Status), ct);
        if (gate is null) return;
        gate.Status = GateStatus.Answered;
        gate.AnsweredAt = DateTime.UtcNow;
        gate.ActingRole = "sta-core";
        gate.DecisionJson = JsonSerializer.Serialize(new { source = "sta-core" }, Json);
        gate.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.System, "gate.answered", actingRole: "sta-core", objectType: "gate",
            objectId: gate.DisplayId, detail: new { source = "answered directly in STA" });
    }

    /// <summary>A new gate for the same run of the same type supersedes a still-open older one (spec §84).</summary>
    public async Task SupersedeEarlierAsync(int knowledgeId, string? module, string gateType, string exceptStaGateKey, CancellationToken ct = default)
    {
        var stale = await db.HumanGates
            .Where(g => g.KnowledgeId == knowledgeId && g.Module == module && g.GateType == gateType
                        && g.StaRunId != null && OpenStatuses.Contains(g.Status) && g.StaGateKey != exceptStaGateKey)
            .ToListAsync(ct);
        foreach (var gate in stale)
        {
            gate.Status = GateStatus.Superseded;
            gate.UpdatedAt = DateTime.UtcNow;
        }
        if (stale.Count > 0) await db.SaveChangesAsync(ct);
    }

    // ───────────────────────── internals ─────────────────────────

    private async Task<string> AuthorizeAnswerAsync(CurrentUser actor, HumanGate gate, CancellationToken ct)
    {
        if (!await knowledges.IsMemberAsync(actor, gate.KnowledgeId, ct))
            throw AppException.Forbidden("คุณไม่ได้เป็นสมาชิกของ Knowledge นี้");

        if (gate.RequiredRole is null)
        {
            var allowed = gate.AssigneeId == actor.UserId || actor.IsOrgAdmin;
            if (!allowed) throw AppException.Forbidden("Gate นี้มอบหมายให้ผู้อื่น");
            return actor.IsOrgAdmin && gate.AssigneeId != actor.UserId ? "org_admin" : "assignee";
        }

        var roles = await assignments.ResolveAsync(actor.UserId, actor.OrganizationId, gate.KnowledgeId, gate.Module, ct);
        if (!roles.Contains(gate.RequiredRole))
            throw AppException.Forbidden($"Gate นี้ต้องการ role \"{gate.RequiredRole}\" — คุณไม่ได้ถือ role นี้ในขอบเขตนี้ (backend ปฏิเสธ ไม่ใช่แค่ซ่อนปุ่ม)");

        if (gate.RoutingMode == GateRoutingMode.PrimaryThenBackup && gate.AssigneeId is not null && gate.AssigneeId != actor.UserId)
            throw AppException.Forbidden("Gate นี้อยู่ในโหมด primary-then-backup: ตอนนี้เป็นตาของ primary — ให้ผู้ดูแล reassign ก่อน");

        return gate.RequiredRole;
    }

    private async Task<bool> CanAnswerAsync(CurrentUser actor, HumanGate gate, Dictionary<(int, string?), HashSet<string>> roleCache, CancellationToken ct)
    {
        try
        {
            if (gate.RequiredRole is null) return gate.AssigneeId == actor.UserId || actor.IsOrgAdmin;
            var key = (gate.KnowledgeId, gate.Module);
            if (!roleCache.TryGetValue(key, out var roles))
                roles = roleCache[key] = await assignments.ResolveAsync(actor.UserId, actor.OrganizationId, gate.KnowledgeId, gate.Module, ct);
            var holdsRole = roles.Contains(gate.RequiredRole);
            return holdsRole && (gate.RoutingMode != GateRoutingMode.PrimaryThenBackup || gate.AssigneeId == null || gate.AssigneeId == actor.UserId);
        }
        catch
        {
            return false;
        }
    }

    private async Task DispatchToStaAsync(HumanGate gate, AnswerGateRequest request, CurrentUser actor, CancellationToken ct)
    {
        // Engine approval: the decision goes INTO the engine's ledger, then the run resumes on it.
        if (gate.StaApprovalRequestId is not null)
        {
            if (gate.StaRunId is null || gate.StaApprovalTaskId is null) return;
            var relayed = request.Approved ?? request.Choice is "continue" or "resume" or "acknowledge";
            await sta.AnswerEngineApprovalAsync(gate.StaRunId, gate.StaApprovalRequestId!, gate.StaApprovalTaskId, relayed, actor.Name, request.Comment, ct);
            await sta.ResumeAsync(gate.StaRunId, ct);
            return;
        }
        if (gate.StaRunId is null) return;
        try
        {
            if (gate.GateType == GateTypes.Review)
            {
                if (request.Approved == true)
                    await sta.ApproveAsync(gate.StaRunId, actor.Name, request.Comment, ct);
                else if (request.Approved == false)
                    await sta.SendBackAsync(gate.StaRunId, actor.Name, request.Comment ?? "sent back from platform review gate", ct);
            }
            else if (request.Choice is "continue" or "resume" or "acknowledge" || request.Approved == true)
            {
                await sta.ResumeAsync(gate.StaRunId, ct);
            }
        }
        catch (Exception error)
        {
            // The decision is durable in the platform; STA may be offline or the run may already be settled.
            logger.LogWarning(error, "gate {Gate} answered but the STA action on run {Run} failed", gate.DisplayId, gate.StaRunId);
            await audit.WriteAsync(ActorType.System, "gate.sta_dispatch_failed", objectType: "gate", objectId: gate.DisplayId,
                detail: new { gate.StaRunId, error.Message }, ct: ct);
        }
    }

    private static (string GateType, string? RequiredRole, GateRoutingMode Routing) MapStaKind(string staKind, int? runCreatorId)
        => staKind switch
        {
            "review" => (GateTypes.Review, "reviewer", GateRoutingMode.AnyAuthorized),
            _ => (GateTypes.Operational, null,
                runCreatorId is not null ? GateRoutingMode.SpecificAssignee : GateRoutingMode.AnyAuthorized),
        };

    private static GateRoutingMode ParseRouting(string? value) => value?.ToLowerInvariant() switch
    {
        "primary_then_backup" => GateRoutingMode.PrimaryThenBackup,
        "specific_assignee" => GateRoutingMode.SpecificAssignee,
        _ => GateRoutingMode.AnyAuthorized,
    };

    private static GateCardDto ToCard(HumanGate gate, bool canAnswer)
    {
        var options = gate.OptionsJson is null ? [] : JsonSerializer.Deserialize<List<string>>(gate.OptionsJson, Json) ?? [];
        string? decisionSummary = null;
        if (gate.DecisionJson is not null)
        {
            var d = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(gate.DecisionJson, Json);
            if (d is not null)
            {
                var parts = new List<string>();
                if (d.TryGetValue("approved", out var approved) && approved.ValueKind == JsonValueKind.True) parts.Add("approve");
                if (d.TryGetValue("approved", out var rejected) && rejected.ValueKind == JsonValueKind.False) parts.Add("reject");
                if (d.TryGetValue("choice", out var choice) && choice.ValueKind == JsonValueKind.String) parts.Add(choice.GetString()!);
                if (d.TryGetValue("comment", out var comment) && comment.ValueKind == JsonValueKind.String && comment.GetString() is { Length: > 0 } c) parts.Add(c);
                decisionSummary = string.Join(" — ", parts) is { Length: > 0 } s ? s : null;
            }
        }
        return new GateCardDto(
            gate.Id, gate.DisplayId, gate.GateType, gate.RequiredRole, gate.Status.ToString(),
            gate.Knowledge?.Name ?? "", gate.Module, gate.Question, gate.AiAnalysis, options, gate.StaRunId,
            gate.Assignee?.Name, gate.CreatedAt, gate.AnsweredBy?.Name, gate.ActingRole, decisionSummary, canAnswer);
    }
}
