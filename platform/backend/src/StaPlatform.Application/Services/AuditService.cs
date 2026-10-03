using System.Text.Json;
using StaPlatform.Application.Common;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Services;

/// <summary>One write path for the platform audit log (spec §70/§71).</summary>
public class AuditService(IAppDbContext db)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public Task WriteAsync(
        ActorType actorType, string action, CurrentUser? actor = null, string? actingRole = null,
        string? objectType = null, string? objectId = null, string? knowledge = null, string? module = null,
        object? detail = null, int? organizationId = null, CancellationToken ct = default)
    {
        db.AuditLogs.Add(new AuditLog
        {
            OrganizationId = organizationId ?? actor?.OrganizationId ?? 0,
            At = DateTime.UtcNow,
            ActorType = actorType,
            ActorId = actor?.UserId,
            ActorName = actor?.Name,
            ActingRole = actingRole,
            Action = action,
            ObjectType = objectType,
            ObjectId = objectId,
            Knowledge = knowledge,
            Module = module,
            DetailJson = detail == null ? null : JsonSerializer.Serialize(detail, JsonOptions),
        });
        return Task.CompletedTask;
    }

    public async Task WriteAndSaveAsync(
        ActorType actorType, string action, CurrentUser? actor = null, string? actingRole = null,
        string? objectType = null, string? objectId = null, string? knowledge = null, string? module = null,
        object? detail = null, int? organizationId = null, CancellationToken ct = default)
    {
        await WriteAsync(actorType, action, actor, actingRole, objectType, objectId, knowledge, module, detail, organizationId, ct);
        await db.SaveChangesAsync(ct);
    }
}
