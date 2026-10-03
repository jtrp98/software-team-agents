using StaPlatform.Application.Models;
using StaPlatform.Application.Services;

namespace StaPlatform.Api.Endpoints;

public static class PoolEndpoints
{
    public static void MapPoolEndpoints(this IEndpointRouteBuilder app)
    {
        var me = app.MapGroup("/api/me/connections").WithTags("pools").RequireAuthorization();

        me.MapGet("/", async (PoolService service, CancellationToken ct) => Results.Ok(await service.MyConnectionsAsync(ct)));

        me.MapPost("/", async (AddConnectionRequest request, PoolService service, CancellationToken ct)
            => Results.Ok(await service.AddMyConnectionAsync(request.RuntimeType, request.Label, ct)));

        me.MapPost("/{id:int}/status", async (int id, UpdateConnectionRequest request, PoolService service, CancellationToken ct) =>
        {
            await service.UpdateMyConnectionAsync(id, request.Status ?? "enabled", ct);
            return Results.Ok(new { ok = true });
        });

        var pools = app.MapGroup("/api/pools").WithTags("pools").RequireAuthorization();

        pools.MapGet("/", async (int? knowledgeId, PoolService service, CancellationToken ct)
            => Results.Ok(await service.AdminListAsync(knowledgeId, ct)));

        pools.MapPost("/connections", async (AddConnectionRequest request, PoolService service, CancellationToken ct)
            => Results.Ok(await service.AdminAddAsync(request, ct)));

        pools.MapPost("/connections/{id:int}", async (int id, UpdateConnectionRequest request, PoolService service, CancellationToken ct)
            => Results.Ok(await service.AdminUpdateAsync(id, request, ct)));

        pools.MapGet("/resolve", async (int knowledgeId, string? module, string role, string? policy, PoolService service, CancellationToken ct)
            => Results.Ok(await service.ResolveOrderAsync(knowledgeId, module, role, policy, ct)));
    }
}
