namespace StaPlatform.Domain.Entities;

/// <summary>
/// The one runtime-capacity abstraction (spec §29): who owns a runtime
/// connection and who may use it. Human responsibility never follows runtime
/// ownership — the scheduler may run a role's work on any connection the pool
/// policy allows.
/// </summary>
public class RuntimeConnection
{
    public int Id { get; set; }
    public int OrganizationId { get; set; }
    /// <summary>One of RuntimeTypes (claude_code, codex, antigravity, zcode).</summary>
    public required string RuntimeType { get; set; }
    public RuntimeOwnerType OwnerType { get; set; }
    /// <summary>User id, Knowledge id or Organization id — see OwnerType.</summary>
    public int OwnerId { get; set; }
    public SharingScope SharingScope { get; set; } = SharingScope.Private;
    public string? Label { get; set; }
    public ConnectionStatus Status { get; set; } = ConnectionStatus.Enabled;
    public string? MachineName { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public enum RuntimeOwnerType
{
    User = 1,
    Knowledge = 2,
    Organization = 3,
}

public enum SharingScope
{
    /// <summary>Only the owning user's own work. Never shared implicitly.</summary>
    Private = 1,
    /// <summary>Shared with the members of the owning Knowledge.</summary>
    KnowledgeMembers = 2,
    /// <summary>Shared organization-wide (fallback pool).</summary>
    Organization = 3,
}

public enum ConnectionStatus
{
    Enabled = 1,
    Disabled = 2,
}

public static class RuntimeTypes
{
    public const string ClaudeCode = "claude_code";
    public const string Codex = "codex";
    public const string Antigravity = "antigravity";
    public const string Zcode = "zcode";

    public static readonly IReadOnlyList<string> All = [ClaudeCode, Codex, Antigravity, Zcode];

    /// <summary>Accepts the human spellings; the canonical id is what is stored.</summary>
    public static string? Canonical(string value) => value.Trim().ToLowerInvariant() switch
    {
        "claude" or "claude-code" or "claude_code" => ClaudeCode,
        "codex" => Codex,
        "agy" or "antigravity" => Antigravity,
        "zcode" => Zcode,
        _ => null,
    };

    public static string? ToStaRuntimeId(string canonical) => canonical switch
    {
        ClaudeCode => "claude-code",
        Codex => "codex",
        Antigravity => "antigravity",
        Zcode => "zcode",
        _ => null,
    };
}
