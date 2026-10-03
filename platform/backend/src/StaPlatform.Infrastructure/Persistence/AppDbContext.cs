using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using StaPlatform.Application.Common;
using StaPlatform.Domain.Entities;

namespace StaPlatform.Infrastructure.Persistence;

/// <summary>The platform's one database context (PostgreSQL/Supabase in production, InMemory in tests).</summary>
public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options), IAppDbContext
{
    public DbSet<Organization> Organizations => Set<Organization>();
    public DbSet<User> Users => Set<User>();
    public DbSet<OrganizationMember> OrganizationMembers => Set<OrganizationMember>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<Knowledge> Knowledges => Set<Knowledge>();
    public DbSet<KnowledgeMember> KnowledgeMembers => Set<KnowledgeMember>();
    public DbSet<RoleAssignment> RoleAssignments => Set<RoleAssignment>();
    public DbSet<RoleCatalogItem> RoleCatalog => Set<RoleCatalogItem>();
    public DbSet<GatePolicy> GatePolicies => Set<GatePolicy>();
    public DbSet<HumanGate> HumanGates => Set<HumanGate>();
    public DbSet<RuntimeConnection> RuntimeConnections => Set<RuntimeConnection>();
    public DbSet<RuntimeUsage> RuntimeUsages => Set<RuntimeUsage>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<WorkRun> WorkRuns => Set<WorkRun>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Enums read as words in the database (Supabase stays human-readable).
        foreach (var property in modelBuilder.Model.GetEntityTypes().SelectMany(t => t.GetProperties()).Where(p => p.ClrType.IsEnum))
        {
            var converter = Activator.CreateInstance(typeof(EnumToStringConverter<>).MakeGenericType(property.ClrType));
            if (converter is ValueConverter typed) property.SetValueConverter(typed);
        }

        modelBuilder.Entity<Organization>(entity =>
        {
            entity.HasIndex(o => o.Slug).IsUnique();
        });

        modelBuilder.Entity<RoleCatalogItem>(entity => entity.HasKey(r => r.Role));
        modelBuilder.Entity<GatePolicy>(entity => entity.HasKey(p => p.GateType));

        modelBuilder.Entity<User>(entity =>
        {
            entity.HasIndex(u => u.Email).IsUnique();
        });

        modelBuilder.Entity<OrganizationMember>(entity =>
        {
            entity.HasKey(m => new { m.OrganizationId, m.UserId });
        });

        modelBuilder.Entity<RefreshToken>(entity =>
        {
            entity.HasIndex(t => t.TokenHash).IsUnique();
            entity.HasOne(t => t.User).WithMany().HasForeignKey(t => t.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Knowledge>(entity =>
        {
            entity.HasIndex(k => new { k.OrganizationId, k.Name }).IsUnique();
            entity.HasOne(k => k.Organization).WithMany().HasForeignKey(k => k.OrganizationId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<KnowledgeMember>(entity =>
        {
            entity.HasKey(m => new { m.KnowledgeId, m.UserId });
            entity.HasOne(m => m.Knowledge).WithMany(k => k.Members).HasForeignKey(m => m.KnowledgeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(m => m.User).WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<RoleAssignment>(entity =>
        {
            entity.HasIndex(a => new { a.OrganizationId, a.UserId, a.Role, a.ScopeKey }).IsUnique();
            entity.HasOne(a => a.User).WithMany().HasForeignKey(a => a.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(a => a.Knowledge).WithMany().HasForeignKey(a => a.KnowledgeId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<HumanGate>(entity =>
        {
            entity.HasIndex(g => new { g.OrganizationId, g.Status });
            entity.HasIndex(g => g.StaRunId);
            entity.HasIndex(g => g.StaGateKey).IsUnique().HasFilter("sta_gate_key IS NOT NULL");
            entity.HasOne(g => g.Knowledge).WithMany().HasForeignKey(g => g.KnowledgeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(g => g.Assignee).WithMany().HasForeignKey(g => g.AssigneeId).OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(g => g.AnsweredBy).WithMany().HasForeignKey(g => g.AnsweredById).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<RuntimeConnection>(entity =>
        {
            entity.HasIndex(c => new { c.OrganizationId, c.RuntimeType, c.OwnerType, c.OwnerId }).IsUnique();
        });

        modelBuilder.Entity<WorkRun>(entity =>
        {
            entity.HasIndex(r => r.StaRunId).IsUnique();
            entity.HasOne(r => r.Knowledge).WithMany().HasForeignKey(r => r.KnowledgeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(r => r.CreatedBy).WithMany().HasForeignKey(r => r.CreatedById).OnDelete(DeleteBehavior.SetNull);
        });

        // Postgres-native features; other providers (tests) keep defaults.
        if (Database.IsNpgsql())
        {
            // Optimistic concurrency on the Postgres system column: two simultaneous gate answers,
            // one commit wins, the other throws DbUpdateConcurrencyException → 409.
            modelBuilder.Entity<HumanGate>().Property<uint>("xmin").IsRowVersion();

            var gate = modelBuilder.Entity<HumanGate>();
            gate.Property(g => g.ContextJson).HasColumnType("jsonb");
            gate.Property(g => g.OptionsJson).HasColumnType("jsonb");
            gate.Property(g => g.BlockedRefsJson).HasColumnType("jsonb");
            gate.Property(g => g.DecisionJson).HasColumnType("jsonb");
            modelBuilder.Entity<AuditLog>().Property(a => a.DetailJson).HasColumnType("jsonb");
        }
    }
}
