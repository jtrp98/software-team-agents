using StaPlatform.Application.Models;
using StaPlatform.Application.Services;

namespace StaPlatform.Api.Endpoints;

public static class KnowledgeEndpoints
{
    public static void MapKnowledgeEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/knowledge").WithTags("knowledge").RequireAuthorization();

        group.MapGet("/", async (KnowledgeService service, CancellationToken ct) => Results.Ok(await service.ListAsync(ct)));

        group.MapPost("/", async (AddKnowledgeRequest request, KnowledgeService service, CancellationToken ct)
            => Results.Ok(await service.AddAsync(request, ct)));

        group.MapGet("/{id:int}", async (int id, KnowledgeService service, CancellationToken ct)
            => Results.Ok(await service.GetAsync(id, ct)));

        group.MapDelete("/{id:int}", async (int id, KnowledgeService service, CancellationToken ct) =>
        {
            await service.DeleteAsync(id, ct);
            return Results.Ok(new { ok = true });
        });

        group.MapGet("/{id:int}/members", async (int id, KnowledgeService service, CancellationToken ct)
            => Results.Ok(await service.MembersAsync(id, ct)));

        group.MapPost("/{id:int}/members", async (int id, AddMemberRequest request, KnowledgeService service, CancellationToken ct) =>
        {
            await service.AddMemberAsync(id, request.UserId, ct);
            return Results.Ok(new { ok = true });
        });

        group.MapDelete("/{id:int}/members/{userId:int}", async (int id, int userId, KnowledgeService service, CancellationToken ct) =>
        {
            await service.RemoveMemberAsync(id, userId, ct);
            return Results.Ok(new { ok = true });
        });
    }
}
