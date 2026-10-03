using System.Security.Claims;
using System.IdentityModel.Tokens.Jwt;
using StaPlatform.Application.Common;

namespace StaPlatform.Api.Auth;

/// <summary>The authenticated principal of the current HTTP request, straight from the validated JWT.</summary>
public class CurrentUserAccessor(IHttpContextAccessor accessor) : ICurrentUserService
{
    public CurrentUser? User => Parse(accessor.HttpContext?.User);

    public CurrentUser RequireUser() => User ?? throw AppException.Unauthorized("ต้องเข้าสู่ระบบก่อน");

    public CurrentUser RequireOrgAdmin()
    {
        var user = RequireUser();
        if (!user.IsOrgAdmin) throw AppException.Forbidden("ต้องเป็นผู้ดูแลองค์กร");
        return user;
    }

    private static CurrentUser? Parse(ClaimsPrincipal? principal)
    {
        if (principal?.Identity?.IsAuthenticated != true) return null;
        var sub = principal.FindFirstValue(JwtRegisteredClaimNames.Sub) ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        if (sub is null || !int.TryParse(sub, out var userId)) return null;
        return new CurrentUser
        {
            UserId = userId,
            Email = principal.FindFirstValue(JwtRegisteredClaimNames.Email) ?? "",
            Name = principal.FindFirstValue("name") ?? "",
            OrganizationId = int.TryParse(principal.FindFirstValue("org"), out var org) ? org : 0,
            IsOrgAdmin = principal.FindFirstValue("org_admin") == "1",
        };
    }
}

public static class AuthCookies
{
    public const string Access = "sta_access";
    public const string Refresh = "sta_refresh";

    public static CookieOptions AccessOptions(bool secure) => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Lax,
        Secure = secure,
        Expires = DateTimeOffset.UtcNow.AddMinutes(60),
    };

    public static CookieOptions RefreshOptions(bool secure) => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Lax,
        Secure = secure,
        Expires = DateTimeOffset.UtcNow.AddDays(30),
        Path = "/api/auth",
    };
}
