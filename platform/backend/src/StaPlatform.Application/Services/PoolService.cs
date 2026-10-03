using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Application.Sta;
using StaPlatform.Domain.Constants;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>
/// Runtime capacity (spec §28–§45): one RuntimeConnection concept with an
/// owner (user / knowledge / organization) and a sharing scope — never three
/// subsystems. The pool policy resolves a role's work to an ordered candidate
/// list; the decision is a recommendation the STA-side scheduler executes.
/// Credentials are never stored here: runtimes authenticate the way their human
/// owner does on the machine.
/// </summary>
public class PoolService(
    IAppDbContext db,
    ICurrentUserService current,
    AssignmentService assignments,
    KnowledgeService knowledges,
    AuditService audit,
    IStaCoreClient sta)
{
    // Role of the AI work → the human role whose capacity should serve it (spec §37).
    private static readonly IReadOnlyDictionary<string, string[]> WorkRoleToHumanRoles = new Dictionary<string, string[]>
    {
        ["commander"] = ["pm"],
        ["engineer"] = ["dev_lead", "developer", "sa"],
        ["reviewer"] = ["reviewer"],
        ["qa"] = ["qa"],
        ["ba"] = ["ba"],
        ["ux"] = ["ux_ui"],
        ["security"] = ["security"],
        ["release"] = ["release_manager"],
    };

    // ───────────────────────── my connections ─────────────────────────

    public async Task<List<ConnectionDto>> MyConnectionsAsync(CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var rows = await db.RuntimeConnections
            .Where(c => c.OrganizationId == actor.OrganizationId && c.OwnerType == RuntimeOwnerType.User && c.OwnerId == actor.UserId)
            .OrderBy(c => c.RuntimeType).ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    public async Task<ConnectionDto> AddMyConnectionAsync(string runtimeType, string? label, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var canonical = RuntimeTypes.Canonical(runtimeType)
            ?? throw new AppException($"runtime ไม่รู้จัก: {runtimeType} (มี {string.Join(", ", RuntimeTypes.All)})");
        if (await db.RuntimeConnections.AnyAsync(c => c.OrganizationId == actor.OrganizationId
            && c.RuntimeType == canonical && c.OwnerType == RuntimeOwnerType.User && c.OwnerId == actor.UserId, ct))
            throw AppException.Conflict("คุณมี connection ของ runtime นี้อยู่แล้ว");

        var now = DateTime.UtcNow;
        var connection = new RuntimeConnection
        {
            OrganizationId = actor.OrganizationId,
            RuntimeType = canonical,
            OwnerType = RuntimeOwnerType.User,
            OwnerId = actor.UserId,
            SharingScope = SharingScope.Private, // smart default: a user's connection is private (spec §31/§100)
            Label = label,
            Status = ConnectionStatus.Enabled,
            MachineName = Environment.MachineName,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.RuntimeConnections.Add(connection);
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "runtime.connected", actor, objectType: "runtime_connection",
            objectId: connection.Id.ToString(), detail: new { runtimeType = canonical, sharing = "Private" }, ct: ct);
        return (await ToDtosAsync([connection], ct))[0];
    }

    public async Task UpdateMyConnectionAsync(int connectionId, string status, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var connection = await db.RuntimeConnections.FirstOrDefaultAsync(c => c.Id == connectionId
            && c.OwnerType == RuntimeOwnerType.User && c.OwnerId == actor.UserId, ct)
            ?? throw AppException.NotFound("ไม่พบ connection นี้ของคุณ");
        connection.Status = ParseStatus(status);
        connection.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, connection.Status == ConnectionStatus.Enabled ? "runtime.connected" : "runtime.disabled",
            actor, objectType: "runtime_connection", objectId: connectionId.ToString(), detail: new { status }, ct: ct);
    }

    // ───────────────────────── admin pools ─────────────────────────

    public async Task<List<ConnectionDto>> AdminListAsync(int? knowledgeId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var query = db.RuntimeConnections.Where(c => c.OrganizationId == actor.OrganizationId);
        if (!actor.IsOrgAdmin)
        {
            // Knowledge admins see their knowledge's shared pool (and the org's, read-only is not required — keep to their knowledge).
            var adminOf = await db.RoleAssignments.Where(a => a.UserId == actor.UserId && a.Role == "knowledge_admin")
                .Select(a => a.KnowledgeId).ToListAsync(ct);
            query = query.Where(c => (c.OwnerType == RuntimeOwnerType.Knowledge && adminOf.Contains(c.OwnerId))
                                     || c.OwnerType == RuntimeOwnerType.Organization);
        }
        if (knowledgeId is not null) query = query.Where(c => c.OwnerType == RuntimeOwnerType.Knowledge && c.OwnerId == knowledgeId);
        var rows = await query.OrderBy(c => c.OwnerType).ThenBy(c => c.RuntimeType).ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    public async Task<ConnectionDto> AdminAddAsync(AddConnectionRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var canonical = RuntimeTypes.Canonical(request.RuntimeType)
            ?? throw new AppException($"runtime ไม่รู้จัก: {request.RuntimeType}");
        var ownerType = ParseOwnerType(request.OwnerType);
        var scope = ParseScope(request.SharingScope);
        var orgId = actor.OrganizationId;

        if (ownerType == RuntimeOwnerType.Organization)
        {
            if (!actor.IsOrgAdmin) throw AppException.Forbidden("จัด pool ขององค์กรได้เฉพาะผู้ดูแลองค์กร");
        }
        else if (ownerType == RuntimeOwnerType.Knowledge)
        {
            var knowledge = await db.Knowledges.FirstOrDefaultAsync(k => k.Id == request.OwnerId && k.OrganizationId == orgId, ct)
                ?? throw AppException.NotFound($"ไม่พบ Knowledge {request.OwnerId}");
            if (!actor.IsOrgAdmin && !await knowledges.IsKnowledgeAdminAsync(actor, knowledge.Id, ct))
                throw AppException.Forbidden("จัด Knowledge pool ได้เฉพาะผู้ดูแล Knowledge นี้");
            if (scope != SharingScope.KnowledgeMembers) throw new AppException("pool ของ Knowledge ต้องแชร์แบบ knowledge_members");
        }
        else
        {
            throw new AppException("เพิ่ม connection ส่วนตัวที่ /me/connections เท่านั้น");
        }

        if (await db.RuntimeConnections.AnyAsync(c => c.OrganizationId == orgId
            && c.RuntimeType == canonical && c.OwnerType == ownerType && c.OwnerId == request.OwnerId, ct))
            throw AppException.Conflict("มี connection ของ runtime นี้สำหรับ owner นี้อยู่แล้ว");

        var now = DateTime.UtcNow;
        var connection = new RuntimeConnection
        {
            OrganizationId = orgId,
            RuntimeType = canonical,
            OwnerType = ownerType,
            OwnerId = request.OwnerId,
            SharingScope = scope,
            Label = request.Label,
            Status = ConnectionStatus.Enabled,
            MachineName = Environment.MachineName,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.RuntimeConnections.Add(connection);
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "runtime.connected", actor, objectType: "runtime_connection",
            objectId: connection.Id.ToString(), detail: new { runtimeType = canonical, ownerType = ownerType.ToString(), sharing = scope.ToString() }, ct: ct);
        return (await ToDtosAsync([connection], ct))[0];
    }

    public async Task<ConnectionDto> AdminUpdateAsync(int connectionId, UpdateConnectionRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var connection = await db.RuntimeConnections.FirstOrDefaultAsync(c => c.Id == connectionId && c.OrganizationId == actor.OrganizationId, ct)
            ?? throw AppException.NotFound($"ไม่พบ connection {connectionId}");
        var mayManage = actor.IsOrgAdmin
            || (connection.OwnerType == RuntimeOwnerType.Knowledge && await knowledges.IsKnowledgeAdminAsync(actor, connection.OwnerId, ct));
        if (!mayManage) throw AppException.Forbidden("ไม่มีสิทธิ์แก้ connection นี้");

        if (request.Status is not null) connection.Status = ParseStatus(request.Status);
        if (request.SharingScope is not null)
        {
            connection.SharingScope = ParseScope(request.SharingScope);
            // Sharing change honors the new policy immediately for future executions (spec §89); audit makes it reviewable.
            await audit.WriteAsync(ActorType.User, "runtime.sharing_changed", actor, objectType: "runtime_connection",
                objectId: connectionId.ToString(), detail: new { sharing = connection.SharingScope.ToString() }, ct: ct);
        }
        connection.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, connection.Status == ConnectionStatus.Disabled ? "runtime.disabled" : "runtime.enabled",
            actor, objectType: "runtime_connection", objectId: connectionId.ToString(), ct: ct);
        return (await ToDtosAsync([connection], ct))[0];
    }

    // ───────────────────────── pool resolution ─────────────────────────

    /// <summary>
    /// Resolves the ordered runtime candidates for one piece of AI work:
    /// the responsible human's private pool → knowledge shared → organization
    /// shared, per policy, health- and security-filtered, least-recently-used
    /// within a tier (spec §34–§36, §78). A user's private connection never
    /// serves someone else's work.
    /// </summary>
    public async Task<ResolveOrderResponse> ResolveOrderAsync(int knowledgeId, string? module, string workRole, string? policy, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var knowledge = await db.Knowledges.FirstOrDefaultAsync(k => k.Id == knowledgeId && k.OrganizationId == actor.OrganizationId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Knowledge {knowledgeId}");
        var resolvedPolicy = policy ?? PoolPolicies.UserKnowledgeOrg;
        if (!PoolPolicies.All.Contains(resolvedPolicy)) throw new AppException($"policy ไม่รู้จัก: {resolvedPolicy}");

        string? responsibleName = null;
        var humanRoles = WorkRoleToHumanRoles.TryGetValue(workRole, out var roles) ? roles : [];
        int? responsibleUserId = null;
        foreach (var role in humanRoles)
        {
            var holders = await assignments.UsersWithRoleAsync(actor.OrganizationId, role, knowledgeId, module, ct);
            if (holders.Count > 0)
            {
                responsibleName = holders[0].User.Name;
                responsibleUserId = holders[0].User.Id;
                break;
            }
        }

        // Tier order per policy (spec §35): PRIVATE_ONLY [user] · USER_THEN_KNOWLEDGE [user,knowledge] ·
        // USER_KNOWLEDGE_ORG [user,knowledge,org] · KNOWLEDGE_FIRST [knowledge,user,org] · SHARED_ONLY [knowledge,org].
        var tierNames = resolvedPolicy switch
        {
            PoolPolicies.PrivateOnly => new[] { "user" },
            PoolPolicies.UserThenKnowledge => new[] { "user", "knowledge" },
            PoolPolicies.KnowledgeFirst => new[] { "knowledge", "user", "organization" },
            PoolPolicies.SharedOnly => new[] { "knowledge", "organization" },
            _ => new[] { "user", "knowledge", "organization" },
        };

        var connections = await db.RuntimeConnections
            .Where(c => c.OrganizationId == actor.OrganizationId && c.Status == ConnectionStatus.Enabled)
            .ToListAsync(ct);
        var pools = new Dictionary<string, List<RuntimeConnection>>
        {
            ["user"] = responsibleUserId is null
                ? []
                : connections.Where(c => c.OwnerType == RuntimeOwnerType.User && c.OwnerId == responsibleUserId).ToList(),
            ["knowledge"] = connections.Where(c => c.OwnerType == RuntimeOwnerType.Knowledge && c.OwnerId == knowledgeId).ToList(),
            ["organization"] = connections.Where(c => c.OwnerType == RuntimeOwnerType.Organization).ToList(),
        };

        var lru = await db.RuntimeUsages
            .Where(u => u.OrganizationId == actor.OrganizationId)
            .GroupBy(u => new { u.RuntimeType, u.OwnerType, u.OwnerId })
            .Select(g => new { g.Key, Last = (DateTime?)g.Max(u => u.StartedAt) })
            .ToListAsync(ct);
        var lastUsed = lru.ToDictionary(x => (x.Key.RuntimeType, x.Key.OwnerType, x.Key.OwnerId), x => x.Last);

        var order = new List<PoolResolveRow>();
        foreach (var tier in tierNames)
        {
            foreach (var connection in pools.GetValueOrDefault(tier, [])
                .OrderBy(c => lastUsed.TryGetValue((c.RuntimeType, c.OwnerType, c.OwnerId), out var at) ? at : DateTime.MinValue))
            {
                if (order.Any(o => o.RuntimeType == connection.RuntimeType)) continue; // the STA router dedupes per type too
                order.Add(new PoolResolveRow(connection.RuntimeType, connection.Id, connection.OwnerType.ToString(), tier));
            }
        }
        return new ResolveOrderResponse(resolvedPolicy, responsibleName, order);
    }

    public async Task RecordUsageAsync(int organizationId, string runtimeType, string? staRunId, string? role, string outcome, string? failureClass, string? detail, CancellationToken ct = default)
    {
        var canonical = RuntimeTypes.Canonical(runtimeType) ?? runtimeType;
        var connection = await db.RuntimeConnections.FirstOrDefaultAsync(c => c.OrganizationId == organizationId
            && c.RuntimeType == canonical && c.OwnerType == RuntimeOwnerType.Organization, ct);
        db.RuntimeUsages.Add(new RuntimeUsage
        {
            OrganizationId = organizationId,
            RuntimeType = canonical,
            OwnerType = connection?.OwnerType ?? RuntimeOwnerType.Organization,
            OwnerId = connection?.OwnerId ?? organizationId,
            StaRunId = staRunId,
            Role = role,
            StartedAt = DateTime.UtcNow,
            Outcome = outcome,
            FailureClass = failureClass,
            Detail = detail,
        });
        await db.SaveChangesAsync(ct);
    }

    // ───────────────────────── helpers ─────────────────────────

    private async Task<List<ConnectionDto>> ToDtosAsync(IEnumerable<RuntimeConnection> rows, CancellationToken ct)
    {
        var staState = new Dictionary<string, StaRuntimeStatus>();
        try
        {
            var statuses = await sta.ListRuntimesAsync(ct);
            staState = (statuses?.Statuses ?? []).ToDictionary(s => s.RuntimeId, s => s);
        }
        catch { /* STA offline: render stored facts only */ }

        var userNames = await db.Users.ToDictionaryAsync(u => u.Id, u => u.Name, ct);
        var knowledgeNames = await db.Knowledges.ToDictionaryAsync(k => k.Id, k => k.Name, ct);
        var orgs = await db.Organizations.ToDictionaryAsync(o => o.Id, o => o.Name, ct);

        return rows.Select(c =>
        {
            var staId = RuntimeTypes.ToStaRuntimeId(c.RuntimeType);
            var status = staId is not null ? staState.GetValueOrDefault(staId) : null;
            var ownerLabel = c.OwnerType switch
            {
                RuntimeOwnerType.User => userNames.GetValueOrDefault(c.OwnerId, $"user {c.OwnerId}"),
                RuntimeOwnerType.Knowledge => knowledgeNames.GetValueOrDefault(c.OwnerId, $"knowledge {c.OwnerId}"),
                _ => orgs.GetValueOrDefault(c.OwnerId, $"org {c.OwnerId}"),
            };
            return new ConnectionDto(c.Id, c.RuntimeType, c.OwnerType.ToString(), c.OwnerId, ownerLabel,
                c.SharingScope.ToString(), c.Status.ToString(), c.Label, c.MachineName,
                status?.State, status?.Authentication, c.CreatedAt);
        }).ToList();
    }

    private static RuntimeOwnerType ParseOwnerType(string value) => value.ToLowerInvariant() switch
    {
        "user" => RuntimeOwnerType.User,
        "knowledge" => RuntimeOwnerType.Knowledge,
        "organization" or "org" => RuntimeOwnerType.Organization,
        _ => throw new AppException($"owner_type ไม่รู้จัก: {value}"),
    };

    private static SharingScope ParseScope(string value) => value.ToLowerInvariant() switch
    {
        "private" => SharingScope.Private,
        "knowledge_members" => SharingScope.KnowledgeMembers,
        "organization" => SharingScope.Organization,
        _ => throw new AppException($"sharing_scope ไม่รู้จัก: {value}"),
    };

    private static ConnectionStatus ParseStatus(string value) => value.ToLowerInvariant() switch
    {
        "enabled" => ConnectionStatus.Enabled,
        "disabled" => ConnectionStatus.Disabled,
        _ => throw new AppException($"status ไม่รู้จัก: {value}"),
    };
}
