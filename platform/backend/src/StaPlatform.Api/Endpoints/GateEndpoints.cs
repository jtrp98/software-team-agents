using StaPlatform.Application.Models;
using StaPlatform.Application.Services;

namespace StaPlatform.Api.Endpoints;

public static class GateEndpoints
{
    public static void MapGateEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/gates").WithTags("gates").RequireAuthorization();

        group.MapGet("/mine", async (GateService service, CancellationToken ct) => Results.Ok(await service.MyGatesAsync(ct)));

        group.MapGet("/counts", async (GateService service, CancellationToken ct) => Results.Ok(await service.CountsByRoleAsync(ct)));

        group.MapGet("/{id:int}", async (int id, GateService service, CancellationToken ct) => Results.Ok(await service.GetAsync(id, ct)));

        group.MapPost("/", async (CreateGateRequest request, GateService service, CancellationToken ct)
            => Results.Ok(await service.CreateAsync(request, ct)));

        group.MapPost("/{id:int}/answer", async (int id, AnswerGateRequest request, GateService service, CancellationToken ct)
            => Results.Ok(await service.AnswerAsync(id, request, ct)));

        group.MapPost("/{id:int}/reassign", async (int id, ReassignGateRequest request, GateService service, CancellationToken ct)
            => Results.Ok(await service.ReassignAsync(id, request.AssigneeId, ct)));

        group.MapPost("/{id:int}/cancel", async (int id, string? reason, GateService service, CancellationToken ct) =>
        {
            await service.CancelAsync(id, reason, ct);
            return Results.Ok(new { ok = true });
        });
    }
}
