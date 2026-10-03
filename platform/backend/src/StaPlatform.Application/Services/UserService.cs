using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace StaPlatform.Application.Services;

/// <summary>User lifecycle (invited → active → suspended/disabled) and admin actions — org admin only (spec §85).</summary>
public class UserService(IAppDbContext db, ICurrentUserService current, IPasswordHasher hasher, AuthService auth, AuditService audit)
{
    public async Task<List<UserDto>> ListAsync(CancellationToken ct = default)
    {
        current.RequireOrgAdmin();
        var orgId = current.RequireUser().OrganizationId;
        var users = await db.Users.OrderBy(u => u.Id).ToListAsync(ct);
        var members = await db.OrganizationMembers.Where(m => m.OrganizationId == orgId).ToDictionaryAsync(m => m.UserId, m => m.OrgRole, ct);
        var assignments = await db.RoleAssignments.Include(a => a.Knowledge).Where(a => a.OrganizationId == orgId).ToListAsync(ct);
        return users.Select(u => ToDto(u, members.TryGetValue(u.Id, out var role) && role == OrgRole.OrgAdmin,
            assignments.Where(a => a.UserId == u.Id).ToList())).ToList();
    }

    public async Task<UserDto> GetAsync(int userId, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        if (actor.UserId != userId && !actor.IsOrgAdmin) throw AppException.Forbidden("ดูผู้ใช้อื่นได้เฉพาะผู้ดูแลองค์กร");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct)
            ?? throw AppException.NotFound($"ไม่พบผู้ใช้ {userId}");
        return await ToDtoWithAssignmentsAsync(user, actor, ct);
    }

    public async Task<UserDto?> GetByEmailAsync(string email, CancellationToken ct = default)
    {
        var actor = current.RequireUser();
        var normalized = email.Trim().ToLowerInvariant();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Email == normalized, ct);
        if (user is null) return null;
        if (actor.UserId != user.Id && !actor.IsOrgAdmin) throw AppException.Forbidden("ดูผู้ใช้อื่นได้เฉพาะผู้ดูแลองค์กร");
        return await ToDtoWithAssignmentsAsync(user, actor, ct);
    }

    private async Task<UserDto> ToDtoWithAssignmentsAsync(User user, CurrentUser actor, CancellationToken ct)
    {
        var isOrgAdmin = await auth.IsOrgAdminAsync(user.Id, actor.OrganizationId, ct);
        var assignments = await db.RoleAssignments.Include(a => a.Knowledge).Where(a => a.UserId == user.Id).ToListAsync(ct);
        return ToDto(user, isOrgAdmin, assignments);
    }

    public async Task<UserDto> InviteAsync(InviteUserRequest request, CancellationToken ct = default)
    {
        var actor = current.RequireOrgAdmin();
        var email = request.Email.Trim().ToLowerInvariant();
        if (!email.Contains('@')) throw new AppException("รูปแบบ email ไม่ถูกต้อง");
        if (string.IsNullOrWhiteSpace(request.Name)) throw new AppException("ต้องระบุชื่อ");
        if (request.Password.Length < 8) throw new AppException("password ต้องยาวอย่างน้อย 8 ตัวอักษร");

        var orgId = actor.OrganizationId;
        if (await db.Users.AnyAsync(u => u.Email == email, ct))
            throw AppException.Conflict($"มีผู้ใช้ email {email} อยู่แล้ว");

        var now = DateTime.UtcNow;
        var user = new User
        {
            Email = email,
            Name = request.Name.Trim(),
            PasswordHash = hasher.Hash(request.Password),
            Status = UserStatus.Active, // Phase 2 has no email delivery: the inviting admin hands over the initial password.
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Users.Add(user);
        db.OrganizationMembers.Add(new OrganizationMember { OrganizationId = orgId, UserId = user.Id, OrgRole = request.OrgAdmin ? OrgRole.OrgAdmin : OrgRole.Member, CreatedAt = now });
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "user.invited", actor, objectType: "user", objectId: user.Id.ToString(),
            detail: new { email, orgAdmin = request.OrgAdmin }, ct: ct);
        return ToDto(user, request.OrgAdmin, []);
    }

    public async Task<UserDto> SetStatusAsync(int userId, string status, CancellationToken ct = default)
    {
        var actor = current.RequireOrgAdmin();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct)
            ?? throw AppException.NotFound($"ไม่พบผู้ใช้ {userId}");
        if (!Enum.TryParse<UserStatus>(status, ignoreCase: true, out var parsed))
            throw new AppException($"สถานะไม่รู้จัก: {status}");
        if (userId == actor.UserId && parsed != UserStatus.Active)
            throw AppException.Conflict("ผู้ดูแลห้ามปิดบัญชีตัวเอง");

        user.Status = parsed;
        user.UpdatedAt = DateTime.UtcNow;
        if (parsed is UserStatus.Suspended or UserStatus.Disabled)
        {
            var tokens = await db.RefreshTokens.Where(t => t.UserId == userId && t.RevokedAt == null).ToListAsync(ct);
            foreach (var token in tokens) token.RevokedAt = DateTime.UtcNow;
        }
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "user.status_changed", actor, objectType: "user",
            objectId: userId.ToString(), detail: new { status = parsed.ToString() }, ct: ct);
        var isOrgAdmin = await auth.IsOrgAdminAsync(userId, actor.OrganizationId, ct);
        var assignments = await db.RoleAssignments.Include(a => a.Knowledge).Where(a => a.UserId == userId).ToListAsync(ct);
        return ToDto(user, isOrgAdmin, assignments);
    }

    public async Task<UserDto> ResetPasswordAsync(int userId, string newPassword, CancellationToken ct = default)
    {
        var actor = current.RequireOrgAdmin();
        if (newPassword.Length < 8) throw new AppException("password ต้องยาวอย่างน้อย 8 ตัวอักษร");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct)
            ?? throw AppException.NotFound($"ไม่พบผู้ใช้ {userId}");
        user.PasswordHash = hasher.Hash(newPassword);
        user.UpdatedAt = DateTime.UtcNow;
        var tokens = await db.RefreshTokens.Where(t => t.UserId == userId && t.RevokedAt == null).ToListAsync(ct);
        foreach (var token in tokens) token.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAndSaveAsync(ActorType.User, "user.password_changed", actor, objectType: "user",
            objectId: userId.ToString(), detail: new { by = "admin" }, ct: ct);
        var isOrgAdmin = await auth.IsOrgAdminAsync(userId, actor.OrganizationId, ct);
        var assignments = await db.RoleAssignments.Include(a => a.Knowledge).Where(a => a.UserId == userId).ToListAsync(ct);
        return ToDto(user, isOrgAdmin, assignments);
    }

    internal static UserDto ToDto(User user, bool isOrgAdmin, List<RoleAssignment> assignments)
        => new(
            user.Id, user.Email, user.Name, user.Status.ToString(), isOrgAdmin, user.CreatedAt, user.LastLoginAt,
            assignments.OrderBy(a => a.KnowledgeId).ThenBy(a => a.Module).Select(a => new AssignmentDto(
                a.Id, a.Role, a.KnowledgeId, a.Knowledge?.Name, a.Module, a.Priority)).ToList());
}
