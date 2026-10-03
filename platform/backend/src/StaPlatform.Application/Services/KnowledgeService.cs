using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Application.Sta;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>
/// Knowledge platform metadata + membership. Knowledge content itself lives in
/// its Git repository — this is system metadata only. Registering a Knowledge
/// also registers the machine-local root on STA Core (one act, one API).
/// </summary>
public class KnowledgeService(IAppDbContext db, ICurrentUserService current, IStaCoreClient sta, AuditService audit)
{
    public async Task<List<KnowledgeDto>> ListAsync(CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var staList = await SafeStaListAsync(ct);
        var staByName = staList.ToDictionary(k => k.Name, k => k);
        var query = db.Knowledges.Include(k => k.Members).ThenInclude(m => m.User).Where(k => k.OrganizationId == actor.OrganizationId);
        if (!actor.IsOrgAdmin) query = query.Where(k => k.Members.Any(m => m.UserId == actor.UserId));
        var rows = await query.OrderBy(k => k.Name).ToListAsync(ct);

        var result = new List<KnowledgeDto>();
        foreach (var knowledge in rows)
        {
            var modules = staByName.TryGetValue(knowledge.Name, out var info) ? info.Modules : [];
            result.Add(ToDto(knowledge, modules, actor));
        }
        // Knowledge roots registered on this STA machine but not yet in the platform (e.g. Phase 1 data): surface them, org admin can adopt.
        if (actor.IsOrgAdmin)
        {
            var known = rows.Select(r => r.Name).ToHashSet();
            foreach (var info in staList.Where(i => !known.Contains(i.Name)))
                result.Add(new KnowledgeDto(0, info.Name, null, null, info.State, true, DateTime.UtcNow, info.Modules, [], true));
        }
        return result;
    }

    public async Task<KnowledgeDto> GetAsync(int knowledgeId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var knowledge = await RequireVisibleAsync(actor, knowledgeId, ct);
        var modules = (await sta.ListModulesAsync(knowledge.Name, ct))?.Modules ?? [];
        return ToDto(knowledge, modules, actor);
    }

    public async Task<KnowledgeDto> AddAsync(AddKnowledgeRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireOrgAdmin();
        var name = request.Name.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z][a-z0-9-]{0,31}$"))
            throw new AppException("ชื่อ Knowledge ต้องเป็น a-z, 0-9, - และขึ้นต้นด้วยตัวอักษร (ชื่อเดียวกับ STA root)");
        var orgId = actor.OrganizationId;
        if (await db.Knowledges.AnyAsync(k => k.OrganizationId == orgId && k.Name == name, ct))
            throw AppException.Conflict($"Knowledge {name} ลงทะเบียนในองค์กรแล้ว");

        if (request.RegisterOnStaMachine)
        {
            var existing = (await SafeStaListAsync(ct)).FirstOrDefault(k => k.Name == name);
            if (existing is null) throw new AppException(
                $"STA Core บนเครื่องนี้ยังไม่มี Knowledge root ชื่อ \"{name}\" — เพิ่มที่ STA ก่อน (sta work / Web UI ของ STA) แล้วจึง adopt ที่นี่");
        }

        var now = DateTime.UtcNow;
        var knowledge = new Knowledge
        {
            OrganizationId = orgId,
            Name = name,
            Slug = name,
            RepositoryUrl = request.RepositoryUrl,
            DefaultBranch = request.DefaultBranch,
            Status = KnowledgeStatus.Ready,
            RegisteredOnThisMachine = request.RegisterOnStaMachine,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Knowledges.Add(knowledge);
        await db.SaveChangesAsync(ct);

        // The inviting admin joins the new Knowledge by default so the happy path works immediately.
        db.KnowledgeMembers.Add(new KnowledgeMember { KnowledgeId = knowledge.Id, UserId = actor.UserId, CreatedAt = now });
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "knowledge.created", actor, objectType: "knowledge",
            objectId: knowledge.Id.ToString(), knowledge: name, detail: new { request.RepositoryUrl }, ct: ct);
        return ToDto(knowledge, [], actor);
    }

    public async Task DeleteAsync(int knowledgeId, CancellationToken ct = default)
    {
        var actor = current.RequireOrgAdmin();
        var knowledge = await db.Knowledges.Include(k => k.Members)
            .FirstOrDefaultAsync(k => k.Id == knowledgeId && k.OrganizationId == actor.OrganizationId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Knowledge {knowledgeId}");
        var openRuns = await db.WorkRuns.CountAsync(r => r.KnowledgeId == knowledgeId
            && r.LastStatus != "APPROVED" && r.LastStatus != "STOPPED" && r.LastStatus != "FAILED", ct);
        if (openRuns > 0) throw AppException.Conflict($"Knowledge นี้มี work run ที่ยังไม่จบ {openRuns} run — หยุดก่อนลบ");
        db.Knowledges.Remove(knowledge);
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "knowledge.deleted", actor, objectType: "knowledge",
            objectId: knowledgeId.ToString(), knowledge: knowledge.Name, ct: ct);
    }

    public async Task<List<MemberDto>> MembersAsync(int knowledgeId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        await RequireVisibleAsync(actor, knowledgeId, ct);
        var rows = await db.KnowledgeMembers.Where(m => m.KnowledgeId == knowledgeId)
            .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new MemberDto(u.Id, u.Name, u.Email, u.Status.ToString()))
            .OrderBy(m => m.Name).ToListAsync(ct);
        return rows;
    }

    public async Task AddMemberAsync(int knowledgeId, int userId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var knowledge = await db.Knowledges.FirstOrDefaultAsync(k => k.Id == knowledgeId && k.OrganizationId == actor.OrganizationId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Knowledge {knowledgeId}");
        if (!actor.IsOrgAdmin && !await IsKnowledgeAdminAsync(actor, knowledgeId, ct))
            throw AppException.Forbidden("เพิ่มสมาชิกได้เฉพาะผู้ดูแลองค์กร / ผู้ดูแล Knowledge นี้");
        _ = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct) ?? throw AppException.NotFound($"ไม่พบผู้ใช้ {userId}");
        if (await db.KnowledgeMembers.AnyAsync(m => m.KnowledgeId == knowledgeId && m.UserId == userId, ct)) return;
        db.KnowledgeMembers.Add(new KnowledgeMember { KnowledgeId = knowledgeId, UserId = userId, CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "knowledge.membership_changed", actor, objectType: "knowledge",
            objectId: knowledgeId.ToString(), knowledge: knowledge.Name, detail: new { added = userId }, ct: ct);
    }

    public async Task RemoveMemberAsync(int knowledgeId, int userId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var knowledge = await db.Knowledges.FirstOrDefaultAsync(k => k.Id == knowledgeId && k.OrganizationId == actor.OrganizationId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Knowledge {knowledgeId}");
        if (!actor.IsOrgAdmin && !await IsKnowledgeAdminAsync(actor, knowledgeId, ct))
            throw AppException.Forbidden("ลบสมาชิกได้เฉพาะผู้ดูแลองค์กร / ผู้ดูแล Knowledge นี้");
        var row = await db.KnowledgeMembers.FirstOrDefaultAsync(m => m.KnowledgeId == knowledgeId && m.UserId == userId, ct);
        if (row is null) return;
        db.KnowledgeMembers.Remove(row);
        await db.SaveChangesAsync(ct);
        // Revocation is immediate: every visibility/answer check joins membership, so nothing else to unwind (spec §87).
        await audit.WriteAndSaveAsync(ActorType.User, "knowledge.membership_changed", actor, objectType: "knowledge",
            objectId: knowledgeId.ToString(), knowledge: knowledge.Name, detail: new { removed = userId }, ct: ct);
    }

    public async Task<bool> IsMemberAsync(CurrentUser actor, int knowledgeId, CancellationToken ct = default)
        => actor.IsOrgAdmin || await db.KnowledgeMembers.AnyAsync(m => m.KnowledgeId == knowledgeId && m.UserId == actor.UserId, ct);

    public async Task<bool> IsKnowledgeAdminAsync(CurrentUser actor, int knowledgeId, CancellationToken ct = default)
        => actor.IsOrgAdmin || await db.RoleAssignments.AnyAsync(a =>
            a.UserId == actor.UserId && a.Role == "knowledge_admin" &&
            (a.KnowledgeId == null || a.KnowledgeId == knowledgeId), ct);

    public async Task<Knowledge> RequireVisibleAsync(CurrentUser actor, int knowledgeId, CancellationToken ct = default)
    {
        var knowledge = await db.Knowledges.Include(k => k.Members)
            .FirstOrDefaultAsync(k => k.Id == knowledgeId && k.OrganizationId == actor.OrganizationId, ct)
            ?? throw AppException.NotFound($"ไม่พบ Knowledge {knowledgeId}");
        if (!await IsMemberAsync(actor, knowledgeId, ct))
            throw AppException.Forbidden("คุณไม่ได้เป็นสมาชิกของ Knowledge นี้");
        return knowledge;
    }

    public async Task<Knowledge?> FindByNameAsync(int organizationId, string name, CancellationToken ct = default)
        => await db.Knowledges.FirstOrDefaultAsync(k => k.OrganizationId == organizationId && k.Name == name, ct);

    private async Task<IReadOnlyList<StaKnowledgeInfo>> SafeStaListAsync(CancellationToken ct)
    {
        try { return await sta.ListKnowledgeAsync(ct); }
        catch { return []; } // STA Core offline: platform metadata still renders; execution features degrade loudly at use time.
    }

    private static KnowledgeDto ToDto(Knowledge knowledge, IReadOnlyList<string> modules, CurrentUser actor)
        => new(
            knowledge.Id, knowledge.Name, knowledge.RepositoryUrl, knowledge.DefaultBranch,
            knowledge.Status.ToString(), knowledge.RegisteredOnThisMachine, knowledge.CreatedAt,
            modules,
            knowledge.Members.Select(m => new MemberDto(m.UserId, m.User?.Name ?? "", "", "")).ToList(),
            actor.IsOrgAdmin || knowledge.Members.Any(m => m.UserId == actor.UserId));
}
