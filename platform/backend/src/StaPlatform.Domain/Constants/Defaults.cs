using StaPlatform.Domain.Entities;

namespace StaPlatform.Domain.Constants;

/// <summary>Default role catalog (spec §10): stable canonical ids, display names are data and may change.</summary>
public static class DefaultRoleCatalog
{
    public static readonly IReadOnlyList<(string Role, string DisplayName)> Items =
    [
        ("ba", "BA"),
        ("pm", "PM"),
        ("ux_ui", "UX/UI"),
        ("sa", "SA"),
        ("dev_lead", "Dev Lead"),
        ("developer", "Developer"),
        ("reviewer", "Reviewer"),
        ("qa", "QA"),
        ("security", "Security"),
        ("release_manager", "Release Manager"),
        ("knowledge_admin", "Knowledge Admin"),
        ("viewer", "Viewer"),
    ];
}

/// <summary>Default data-driven gate_type → role policy (spec §12). Rows in gate_policies are the source of truth once seeded.</summary>
public static class DefaultGatePolicies
{
    public static readonly IReadOnlyList<(string GateType, string RequiredRole)> Items =
    [
        (GateTypes.RequirementDecision, "ba"),
        (GateTypes.ScopeDecision, "pm"),
        (GateTypes.UxDecision, "ux_ui"),
        (GateTypes.ArchitectureDecision, "sa"),
        (GateTypes.DevDecision, "dev_lead"),
        (GateTypes.QaDecision, "qa"),
        (GateTypes.SecurityDecision, "security"),
        (GateTypes.ReleaseDecision, "release_manager"),
        (GateTypes.Review, "reviewer"),
    ];
}

public static class PoolPolicies
{
    public const string PrivateOnly = "PRIVATE_ONLY";
    public const string UserThenKnowledge = "USER_THEN_KNOWLEDGE";
    public const string UserKnowledgeOrg = "USER_KNOWLEDGE_ORG";
    public const string KnowledgeFirst = "KNOWLEDGE_FIRST";
    public const string SharedOnly = "SHARED_ONLY";

    public static readonly IReadOnlyList<string> All = [PrivateOnly, UserThenKnowledge, UserKnowledgeOrg, KnowledgeFirst, SharedOnly];
}
