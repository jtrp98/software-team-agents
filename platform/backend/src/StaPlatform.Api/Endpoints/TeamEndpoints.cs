using StaPlatform.Application.Models;
using StaPlatform.Application.Services;

namespace StaPlatform.Api.Endpoints;

public static class TeamEndpoints
{
    public static void MapTeamEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/team").WithTags("team").RequireAuthorization();

        group.MapGet("/", async (int knowledgeId, string? module, TeamService service, CancellationToken ct)
            => Results.Ok(await service.ViewAsync(knowledgeId, module, ct)));
    }
}
