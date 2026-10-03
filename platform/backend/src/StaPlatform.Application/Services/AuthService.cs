using StaPlatform.Application.Common;
using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Models;
using StaPlatform.Domain.Entities;
using StaPlatform.Domain.Constants;

namespace StaPlatform.Application.Services;

/// <summary>Login / refresh / logout / password change. Access = short-lived JWT (cookie or header); refresh = hashed row in the database.</summary>
public class AuthService(IAppDbContext db, IPasswordHasher hasher, ITokenService tokens)
{
    public const string DefaultOrgSlug = "default";
    public const string DefaultAdminEmail = "admin@sta.local";

    public async Task<AuthResponse> LoginAsync(LoginRequest request, CancellationToken ct = default)
    {
        var user = await FindUserAsync(request.Email, ct);
        if (user is null || !hasher.Verify(request.Password, user.PasswordHash))
            throw AppException.Unauthorized("email หรือ password ไม่ถูกต้อง");
        if (user.Status != UserStatus.Active)
            throw AppException.Forbidden($"บัญชีนี้อยู่ในสถานะ {user.Status} — ผู้ดูแลต้องเปิดใช้งานก่อน");

        var org = await DefaultOrganizationAsync(ct);
        var isOrgAdmin = await IsOrgAdminAsync(user.Id, org.Id, ct);

        var access = tokens.CreateAccessToken(user.Id, user.Email, user.Name, org.Id, isOrgAdmin);
        var (refresh, refreshHash) = tokens.NewRefreshToken();
        var refreshExpires = DateTime.UtcNow.AddDays(30);
        db.RefreshTokens.Add(new RefreshToken
        {
            UserId = user.Id,
            TokenHash = refreshHash,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = refreshExpires,
        });
        user.LastLoginAt = DateTime.UtcNow;
        user.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        return new AuthResponse(access.Token, access.ExpiresAt, refresh, refreshExpires, await MeAsync(user, org.Id, isOrgAdmin, ct));
    }

    public async Task<AuthResponse> RefreshAsync(string refreshToken, CancellationToken ct = default)
    {
        var hash = tokens.HashRefreshToken(refreshToken);
        var row = await db.RefreshTokens.Include(t => t.User).FirstOrDefaultAsync(t => t.TokenHash == hash, ct)
            ?? throw AppException.Unauthorized("refresh token ไม่ถูกต้อง");
        if (row.RevokedAt is not null || row.ExpiresAt <= DateTime.UtcNow)
            throw AppException.Unauthorized("refresh token หมดอายุแล้ว");

        var org = await DefaultOrganizationAsync(ct);
        var isOrgAdmin = await IsOrgAdminAsync(row.UserId, org.Id, ct);
        var user = row.User;
        if (user.Status != UserStatus.Active) throw AppException.Unauthorized("บัญชีไม่พร้อมใช้งาน");

        // Rotate: the presented token dies, a fresh pair is born.
        row.RevokedAt = DateTime.UtcNow;
        var access = tokens.CreateAccessToken(user.Id, user.Email, user.Name, org.Id, isOrgAdmin);
        var (nextRefresh, nextHash) = tokens.NewRefreshToken();
        var refreshExpires = DateTime.UtcNow.AddDays(30);
        db.RefreshTokens.Add(new RefreshToken { UserId = user.Id, TokenHash = nextHash, CreatedAt = DateTime.UtcNow, ExpiresAt = refreshExpires });
        await db.SaveChangesAsync(ct);
        return new AuthResponse(access.Token, access.ExpiresAt, nextRefresh, refreshExpires, await MeAsync(user, org.Id, isOrgAdmin, ct));
    }

    public async Task LogoutAsync(string refreshToken, CancellationToken ct = default)
    {
        var hash = tokens.HashRefreshToken(refreshToken);
        var row = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
        if (row is not null && row.RevokedAt is null)
        {
            row.RevokedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }
    }

    public async Task ChangeOwnPasswordAsync(CurrentUser actor, string currentPassword, string newPassword, CancellationToken ct = default)
    {
        var user = await db.Users.FirstAsync(u => u.Id == actor.UserId, ct);
        if (!hasher.Verify(currentPassword, user.PasswordHash))
            throw AppException.Forbidden("current password ไม่ถูกต้อง");
        user.PasswordHash = hasher.Hash(newPassword);
        user.UpdatedAt = DateTime.UtcNow;
        // Every other session dies; the caller keeps its own refresh token row valid by re-issuing below.
        var rows = await db.RefreshTokens.Where(t => t.UserId == user.Id && t.RevokedAt == null).ToListAsync(ct);
        foreach (var row in rows) row.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public async Task<MeResponse> MeAsync(CurrentUser actor, CancellationToken ct = default)
    {
        var visible = await VisibleKnowledgeNamesAsync(actor, ct);
        return new MeResponse(actor.UserId, actor.Email, actor.Name, actor.IsOrgAdmin, visible);
    }

    public async Task<List<string>> VisibleKnowledgeNamesAsync(CurrentUser actor, CancellationToken ct = default)
    {
        if (actor.IsOrgAdmin)
            return await db.Knowledges.Where(k => k.OrganizationId == actor.OrganizationId)
                .OrderBy(k => k.Name).Select(k => k.Name).ToListAsync(ct);
        return await db.KnowledgeMembers.Where(m => m.UserId == actor.UserId && m.Knowledge.OrganizationId == actor.OrganizationId)
            .OrderBy(m => m.Knowledge.Name).Select(m => m.Knowledge.Name).ToListAsync(ct);
    }

    public async Task<Organization> DefaultOrganizationAsync(CancellationToken ct = default)
        => await db.Organizations.FirstAsync(o => o.Slug == DefaultOrgSlug, ct);

    public async Task<bool> IsOrgAdminAsync(int userId, int organizationId, CancellationToken ct = default)
        => await db.OrganizationMembers.AnyAsync(
            m => m.UserId == userId && m.OrganizationId == organizationId && m.OrgRole == OrgRole.OrgAdmin, ct);

    private Task<User?> FindUserAsync(string email, CancellationToken ct)
    {
        var normalized = email.Trim().ToLowerInvariant();
        return db.Users.FirstOrDefaultAsync(u => u.Email == normalized, ct);
    }

    private async Task<MeResponse> MeAsync(User user, int organizationId, bool isOrgAdmin, CancellationToken ct)
        => new(user.Id, user.Email, user.Name, isOrgAdmin, await VisibleKnowledgeNamesAsync(
            new CurrentUser { UserId = user.Id, Email = user.Email, Name = user.Name, OrganizationId = organizationId, IsOrgAdmin = isOrgAdmin }, ct));

    /// <summary>Seed: default organization + default admin account + role catalog + gate policies. Idempotent.</summary>
    public async Task SeedAsync(string adminPassword, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var org = await db.Organizations.FirstOrDefaultAsync(o => o.Slug == DefaultOrgSlug, ct);
        if (org is null)
        {
            org = new Organization { Name = "Default Organization", Slug = DefaultOrgSlug, CreatedAt = now, UpdatedAt = now };
            db.Organizations.Add(org);
        }

        if (!db.RoleCatalog.Any())
        {
            var order = 0;
            foreach (var (role, display) in DefaultRoleCatalog.Items)
                db.RoleCatalog.Add(new RoleCatalogItem { Role = role, DisplayName = display, SortOrder = order++ });
        }

        if (!db.GatePolicies.Any())
            foreach (var (gateType, role) in DefaultGatePolicies.Items)
                db.GatePolicies.Add(new GatePolicy { GateType = gateType, RequiredRole = role });

        await db.SaveChangesAsync(ct);

        var admin = await db.Users.FirstOrDefaultAsync(u => u.Email == DefaultAdminEmail, ct);
        if (admin is null)
        {
            admin = new User
            {
                Email = DefaultAdminEmail,
                Name = "Admin",
                PasswordHash = hasher.Hash(adminPassword),
                Status = UserStatus.Active,
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.Users.Add(admin);
            await db.SaveChangesAsync(ct);
        }

        if (!await db.OrganizationMembers.AnyAsync(m => m.OrganizationId == org.Id && m.UserId == admin.Id, ct))
        {
            db.OrganizationMembers.Add(new OrganizationMember { OrganizationId = org.Id, UserId = admin.Id, OrgRole = OrgRole.OrgAdmin, CreatedAt = now });
            await db.SaveChangesAsync(ct);
        }
    }
}
