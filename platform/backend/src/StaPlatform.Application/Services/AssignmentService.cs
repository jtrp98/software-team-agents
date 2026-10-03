using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>
/// Role assignments: many-to-many, scoped (org / knowledge / module), with
/// effective-role resolution. The admin's assignment UI reads and writes
/// through here — one transactional replace, every diff audited (spec §86).
/// </summary>
public class AssignmentService(IAppDbContext db, ICurrentUserService current, AuditService audit)
{
    public async Task<IReadOnlyList<string>> EffectiveRolesAsync(int userId, int? knowledgeId, string? module, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        // A user may inspect their own effective roles; org admins may inspect anyone's.
        if (actor.UserId != userId && !actor.IsOrgAdmin) throw AppException.Forbidden("ดู role ของผู้อื่นได้เฉพาะผู้ดูแลองค์กร");
        return [.. (await ResolveAsync(userId, actor.OrganizationId, knowledgeId, module, ct)).OrderBy(r => r)];
    }

    /// <summary>The scope ladder: org-wide + knowledge-level + module-level. Scope is checked every time — nothing leaks across Knowledge.</summary>
    public async Task<HashSet<string>> ResolveAsync(int userId, int organizationId, int? knowledgeId, string? module, CancellationToken ct = default)
    {
        // A role inside a Knowledge exists only while the user is still a member of it (spec §87: revocation is immediate).
        if (knowledgeId is not null && !await db.KnowledgeMembers.AnyAsync(m => m.KnowledgeId == knowledgeId && m.UserId == userId, ct))
            return [];
        var rows = await db.RoleAssignments
            .Where(a => a.OrganizationId == organizationId && a.UserId == userId)
            .Select(a => new { a.Role, a.KnowledgeId, a.Module })
            .ToListAsync(ct);
        var roles = new HashSet<string>();
        foreach (var row in rows)
        {
            if (row.KnowledgeId is null) roles.Add(row.Role);
            else if (knowledgeId is not null && row.KnowledgeId == knowledgeId)
            {
                if (row.Module is null || (module is not null && row.Module == module)) roles.Add(row.Role);
            }
        }
        return roles;
    }

    /// <summary>Active members of a Knowledge holding a role effectively in (knowledge, module), most primary first.</summary>
    public async Task<List<(User User, int Priority)>> UsersWithRoleAsync(
        int organizationId, string role, int knowledgeId, string? module, CancellationToken ct = default)
    {
        var assignments = await db.RoleAssignments.Include(a => a.User)
            .Where(a => a.OrganizationId == organizationId && a.Role == role &&
                        (a.KnowledgeId == null || a.KnowledgeId == knowledgeId) &&
                        (a.Module == null || a.Module == module))
            .ToListAsync(ct);
        var members = await db.KnowledgeMembers.Where(m => m.KnowledgeId == knowledgeId).Select(m => m.UserId).ToListAsync(ct);
        var memberSet = members.ToHashSet();
        return assignments
            .Where(a => a.User.Status == UserStatus.Active && memberSet.Contains(a.UserId))
            .GroupBy(a => a.UserId)
            .Select(g => (g.First().User, g.Max(a => a.Priority)))
            .OrderByDescending(x => x.Item2).ThenBy(x => x.User.Name)
            .ToList();
    }

    public async Task<List<AssignmentDto>> GetAsync(int userId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        if (actor.UserId != userId && !actor.IsOrgAdmin) throw AppException.Forbidden("ดู assignment ของผู้อื่นได้เฉพาะผู้ดูแลองค์กร");
        var rows = await db.RoleAssignments.Include(a => a.Knowledge).Where(a => a.UserId == userId).ToListAsync(ct);
        return rows.OrderBy(a => a.KnowledgeId).ThenBy(a => a.Module).ThenBy(a => a.Role)
            .Select(a => new AssignmentDto(a.Id, a.Role, a.KnowledgeId, a.Knowledge?.Name, a.Module, a.Priority)).ToList();
    }

    /// <summary>Transactional replace of one user's assignments. Past decisions keep their provenance (spec §86) — only future routing changes.</summary>
    public async Task<List<AssignmentDto>> SetAsync(int userId, SetAssignmentsRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var isKnowledgeAdmin = await IsAtLeastKnowledgeAdminAsync(actor, ct);
        if (!actor.IsOrgAdmin && !isKnowledgeAdmin)
            throw AppException.Forbidden("แก้ assignment ได้เฉพาะผู้ดูแลองค์กร / ผู้ดูแล Knowledge");

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct)
            ?? throw AppException.NotFound($"ไม่พบผู้ใช้ {userId}");
        var orgId = actor.OrganizationId;

        var catalog = (await db.RoleCatalog.ToListAsync(ct)).Select(r => r.Role).ToHashSet();
        foreach (var item in request.Assignments)
        {
            if (!catalog.Contains(item.Role)) throw new AppException($"role ไม่อยู่ใน catalog: {item.Role}");
            if (item.Module is not null && item.KnowledgeId is null) throw new AppException("assignment ระดับ Module ต้องระบุ Knowledge ด้วย");
            if (item.KnowledgeId is not null)
                _ = await db.Knowledges.FirstOrDefaultAsync(k => k.Id == item.KnowledgeId && k.OrganizationId == orgId, ct)
                    ?? throw AppException.NotFound($"Knowledge {item.KnowledgeId} ไม่ได้ลงทะเบียนในองค์กรนี้");
        }

        var now = DateTime.UtcNow;
        var currentRows = await db.RoleAssignments.Include(a => a.Knowledge).Where(a => a.UserId == userId).ToListAsync(ct);
        var desired = request.Assignments
            .Select(a => (Role: a.Role, KnowledgeId: a.KnowledgeId, Module: a.Module, Priority: a.Priority))
            .Distinct()
            .ToList();

        foreach (var row in currentRows)
        {
            var keep = desired.Any(d => d.Role == row.Role && d.KnowledgeId == row.KnowledgeId && d.Module == row.Module);
            if (keep) continue;
            db.RoleAssignments.Remove(row);
            await audit.WriteAsync(ActorType.User, "role.removed", actor, objectType: "user", objectId: userId.ToString(),
                knowledge: row.Knowledge?.Name, module: row.Module, detail: new { role = row.Role }, ct: ct);
        }

        foreach (var (role, knowledgeId, module, priority) in desired)
        {
            if (currentRows.Any(r => r.Role == role && r.KnowledgeId == knowledgeId && r.Module == module)) continue;
            db.RoleAssignments.Add(new RoleAssignment
            {
                OrganizationId = orgId,
                UserId = userId,
                Role = role,
                KnowledgeId = knowledgeId,
                Module = module,
                ScopeKey = $"{knowledgeId?.ToString() ?? ""}|{module ?? ""}",
                Priority = priority,
                CreatedAt = now,
            });
            var knowledgeName = knowledgeId is null ? null : (await db.Knowledges.FirstAsync(k => k.Id == knowledgeId, ct)).Name;
            await audit.WriteAsync(ActorType.User, "role.assigned", actor, objectType: "user", objectId: userId.ToString(),
                knowledge: knowledgeName, module: module, detail: new { role }, ct: ct);
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "assignment.changed", actor, objectType: "user", objectId: userId.ToString(),
            detail: new { total = desired.Count }, ct: ct);
        return await GetAsync(userId, ct);
    }

    public async Task<List<RoleCatalogDto>> RoleCatalogAsync(CancellationToken ct = default)
        => await db.RoleCatalog.OrderBy(r => r.SortOrder)
            .Select(r => new RoleCatalogDto(r.Role, r.DisplayName)).ToListAsync(ct);

    public async Task<List<GatePolicyDto>> GatePoliciesAsync(CancellationToken ct = default)
        => await db.GatePolicies.OrderBy(p => p.GateType)
            .Select(p => new GatePolicyDto(p.GateType, p.RequiredRole)).ToListAsync(ct);

    private async Task<bool> IsAtLeastKnowledgeAdminAsync(CurrentUser actor, CancellationToken ct)
        => await db.RoleAssignments.AnyAsync(a => a.UserId == actor.UserId && a.Role == "knowledge_admin", ct);
}
