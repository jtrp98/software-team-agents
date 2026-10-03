namespace StaPlatform.Domain.Entities;

/// <summary>
/// The platform audit log (spec §70/§71): every authorization-relevant change,
/// every human decision, every AI attribution event — who, what, when, why.
/// </summary>
public class AuditLog
{
    public int Id { get; set; }
    public int OrganizationId { get; set; }
    public DateTime At { get; set; }
    public ActorType ActorType { get; set; }
    public int? ActorId { get; set; }
    public string? ActorName { get; set; }
    public string? ActingRole { get; set; }
    public required string Action { get; set; }
    public string? ObjectType { get; set; }
    public string? ObjectId { get; set; }
    public string? Knowledge { get; set; }
    public string? Module { get; set; }
    public string? DetailJson { get; set; }
}
