using StaPlatform.Application.Common;
using StaPlatform.Application.Models;
using StaPlatform.Application.Services;

namespace StaPlatform.Api.Endpoints;

public static class UserEndpoints
{
    public static void MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var users = app.MapGroup("/api/users").WithTags("users").RequireAuthorization();

        users.MapGet("/", async (UserService service, CancellationToken ct) => Results.Ok(await service.ListAsync(ct)));

        users.MapPost("/", async (InviteUserRequest request, UserService service, CancellationToken ct)
            => Results.Ok(await service.InviteAsync(request, ct)));

        users.MapGet("/{id:int}", async (int id, UserService service, CancellationToken ct)
            => Results.Ok(await service.GetAsync(id, ct)));

        users.MapGet("/by-email/{email}", async (string email, UserService service, CancellationToken ct) =>
        {
            var user = await service.GetByEmailAsync(email, ct);
            return user is null ? Results.NotFound(new { error = $"ไม่พบผู้ใช้ {email}" }) : Results.Ok(user);
        });

        users.MapPost("/{id:int}/status", async (int id, SetUserStatusRequest request, UserService service, CancellationToken ct)
            => Results.Ok(await service.SetStatusAsync(id, request.Status, ct)));

        users.MapPost("/{id:int}/reset-password", async (int id, ResetPasswordRequest request, UserService service, CancellationToken ct)
            => Results.Ok(await service.ResetPasswordAsync(id, request.NewPassword, ct)));

        users.MapGet("/{id:int}/assignments", async (int id, AssignmentService service, CancellationToken ct)
            => Results.Ok(await service.GetAsync(id, ct)));

        users.MapPut("/{id:int}/assignments", async (int id, SetAssignmentsRequest request, AssignmentService service, CancellationToken ct)
            => Results.Ok(await service.SetAsync(id, request, ct)));

        var me = app.MapGroup("/api/me").WithTags("users").RequireAuthorization();
        me.MapGet("/roles", async (int? knowledgeId, string? module, AssignmentService service, ICurrentUserService current, CancellationToken ct)
            => Results.Ok(new EffectiveRolesResponse(await service.EffectiveRolesAsync(current.RequireUser().UserId, knowledgeId, module, ct))));
    }
}
