using Microsoft.EntityFrameworkCore;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Application.Common;

/// <summary>The EF Core database of the platform. One DbContext, one schema, Npgsql in production.</summary>
public interface IAppDbContext
{
    DbSet<Organization> Organizations { get; }
    DbSet<User> Users { get; }
    DbSet<OrganizationMember> OrganizationMembers { get; }
    DbSet<RefreshToken> RefreshTokens { get; }
    DbSet<Knowledge> Knowledges { get; }
    DbSet<KnowledgeMember> KnowledgeMembers { get; }
    DbSet<RoleAssignment> RoleAssignments { get; }
    DbSet<RoleCatalogItem> RoleCatalog { get; }
    DbSet<GatePolicy> GatePolicies { get; }
    DbSet<HumanGate> HumanGates { get; }
    DbSet<RuntimeConnection> RuntimeConnections { get; }
    DbSet<RuntimeUsage> RuntimeUsages { get; }
    DbSet<AuditLog> AuditLogs { get; }
    DbSet<WorkRun> WorkRuns { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
