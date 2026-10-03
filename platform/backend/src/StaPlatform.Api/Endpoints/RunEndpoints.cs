using StaPlatform.Application.Models;
using StaPlatform.Application.Services;
using StaPlatform.Application.Sta;

namespace StaPlatform.Api.Endpoints;

public static class RunEndpoints
{
    public static void MapRunEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/runs").WithTags("runs").RequireAuthorization();

        group.MapPost("/", async (StartRunRequest request, RunService service, CancellationToken ct)
            => Results.Ok(await service.StartAsync(request, ct)));

        group.MapGet("/", async (string? status, string? knowledge, string? module, RunService service, CancellationToken ct)
            => Results.Ok(await service.ListAsync(status, knowledge, module, ct)));

        group.MapGet("/{staRunId}", async (string staRunId, RunService service, CancellationToken ct)
            => Results.Ok(await service.GetAsync(staRunId, ct)));

        group.MapGet("/{staRunId}/diff", async (string staRunId, RunService service, CancellationToken ct)
            => Results.Ok(await service.GetDiffAsync(staRunId, ct)));

        group.MapGet("/{staRunId}/prepare-commit", async (string staRunId, RunService service, CancellationToken ct)
            => Results.Ok(await service.GetPrepareCommitAsync(staRunId, ct)));

        group.MapPost("/{staRunId}/pause", async (string staRunId, RunService service, CancellationToken ct)
            => Results.Ok(await service.ControlAsync(staRunId, "pause", null, null, ct)));

        group.MapPost("/{staRunId}/resume", async (string staRunId, RunService service, CancellationToken ct)
            => Results.Ok(await service.ControlAsync(staRunId, "resume", null, null, ct)));

        group.MapPost("/{staRunId}/stop", async (string staRunId, bool? force, RunService service, CancellationToken ct)
            => Results.Ok(await service.ControlAsync(staRunId, "stop", force, null, ct)));

        group.MapPost("/{staRunId}/approve", async (string staRunId, string? note, RunService service, CancellationToken ct)
            => Results.Ok(await service.ReviewAsync(staRunId, true, note, ct)));

        group.MapPost("/{staRunId}/send-back", async (string staRunId, string? note, RunService service, CancellationToken ct)
            => Results.Ok(await service.ReviewAsync(staRunId, false, note, ct)));
    }
}
