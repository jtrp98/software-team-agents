using Microsoft.AspNetCore.Authentication.JwtBearer;
using StaPlatform.Api.Auth;
using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Application.Services;

namespace StaPlatform.Api.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this IEndpointRouteBuilder app, bool secureCookies)
    {
        var group = app.MapGroup("/api/auth").WithTags("auth");

        group.MapPost("/login", async (LoginRequest request, AuthService auth, HttpContext http, CancellationToken ct) =>
        {
            var response = await auth.LoginAsync(request, ct);
            http.Response.Cookies.Append(AuthCookies.Access, response.AccessToken, AuthCookies.AccessOptions(secureCookies));
            http.Response.Cookies.Append(AuthCookies.Refresh, response.RefreshToken, AuthCookies.RefreshOptions(secureCookies));
            return Results.Ok(response);
        }).AllowAnonymous();

        group.MapPost("/refresh", async (HttpRequest httpRequest, AuthService auth, HttpContext http, CancellationToken ct) =>
        {
            var body = await httpRequest.ReadFromJsonAsync<RefreshRequest>(ct);
            var token = body?.RefreshToken ?? httpRequest.Cookies[AuthCookies.Refresh]
                ?? throw AppException.Unauthorized("ไม่มี refresh token");
            var response = await auth.RefreshAsync(token, ct);
            http.Response.Cookies.Append(AuthCookies.Access, response.AccessToken, AuthCookies.AccessOptions(secureCookies));
            http.Response.Cookies.Append(AuthCookies.Refresh, response.RefreshToken, AuthCookies.RefreshOptions(secureCookies));
            return Results.Ok(response);
        }).AllowAnonymous();

        group.MapPost("/logout", async (HttpRequest httpRequest, AuthService auth, HttpContext http, CancellationToken ct) =>
        {
            var body = await httpRequest.ReadFromJsonAsync<RefreshRequest>(ct);
            var token = body?.RefreshToken ?? httpRequest.Cookies[AuthCookies.Refresh];
            if (token is not null) await auth.LogoutAsync(token, ct);
            http.Response.Cookies.Delete(AuthCookies.Access);
            http.Response.Cookies.Delete(AuthCookies.Refresh);
            return Results.Ok(new { ok = true });
        }).AllowAnonymous();

        group.MapGet("/me", async (ICurrentUserService current, AuthService auth, CancellationToken ct) =>
            Results.Ok(await auth.MeAsync(current.RequireUser(), ct))).RequireAuthorization();

        group.MapPost("/change-password", async (ChangePasswordRequest request, ICurrentUserService current, AuthService auth, HttpContext http, CancellationToken ct) =>
        {
            await auth.ChangeOwnPasswordAsync(current.RequireUser(), request.CurrentPassword, request.NewPassword, ct);
            http.Response.Cookies.Delete(AuthCookies.Access);
            http.Response.Cookies.Delete(AuthCookies.Refresh);
            return Results.Ok(new { ok = true, note = "เปลี่ยนรหัสผ่านแล้ว — โปรดเข้าสู่ระบบใหม่" });
        }).RequireAuthorization();

        // Warm-up endpoint for the frontend: no auth required, tells the app whether a session is alive.
        group.MapGet("/status", (ICurrentUserService current) =>
        {
            var user = current.User;
            return Results.Ok(new { authenticated = user is not null, user });
        }).AllowAnonymous();
    }
}
