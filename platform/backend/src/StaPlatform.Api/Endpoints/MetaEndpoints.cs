using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Common;
using StaPlatform.Application.Services;
using StaPlatform.Domain.Constants;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Api.Endpoints;

public static class MetaEndpoints
{
    public static void MapMetaEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/meta/health", () => Results.Ok(new { ok = true, service = "sta-platform" })).WithTags("meta").AllowAnonymous();

        app.MapGet("/api/meta/runtime-types", () => Results.Ok(RuntimeTypes.All)).WithTags("meta").RequireAuthorization();
        app.MapGet("/api/meta/pool-policies", () => Results.Ok(PoolPolicies.All)).WithTags("meta").RequireAuthorization();

        app.MapGet("/api/roles", async (AssignmentService service, CancellationToken ct)
            => Results.Ok(await service.RoleCatalogAsync(ct))).WithTags("meta").RequireAuthorization();

        app.MapGet("/api/gate-policies", async (AssignmentService service, CancellationToken ct)
            => Results.Ok(await service.GatePoliciesAsync(ct))).WithTags("meta").RequireAuthorization();

        app.MapGet("/api/audit", async (IAppDbContext db, ICurrentUserService current, int limit, CancellationToken ct) =>
        {
            current.RequireOrgAdmin();
            var orgId = current.RequireUser().OrganizationId;
            var rows = await db.AuditLogs.Where(a => a.OrganizationId == orgId)
                .OrderByDescending(a => a.Id).Take(Math.Clamp(limit, 1, 1000))
                .ToListAsync(ct);
            return Results.Ok(rows);
        }).WithTags("meta").RequireAuthorization();

        app.MapGet("/api/audit/usage", async (IAppDbContext db, ICurrentUserService current, int days, CancellationToken ct) =>
        {
            current.RequireOrgAdmin();
            var orgId = current.RequireUser().OrganizationId;
            var since = DateTime.UtcNow.AddDays(-Math.Clamp(days, 1, 365));
            var rows = await db.RuntimeUsages
                .Where(u => u.OrganizationId == orgId && u.StartedAt >= since)
                .GroupBy(u => new { u.RuntimeType, u.Outcome })
                .Select(g => new { g.Key.RuntimeType, g.Key.Outcome, Count = g.Count() })
                .ToListAsync(ct);
            return Results.Ok(rows);
        }).WithTags("meta").RequireAuthorization();
    }
}
