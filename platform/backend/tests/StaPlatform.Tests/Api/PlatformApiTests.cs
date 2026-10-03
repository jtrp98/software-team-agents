using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using StaPlatform.Domain.Entities;
using StaPlatform.Infrastructure.Persistence;
using Xunit;

namespace StaPlatform.Tests.Api;

/// <summary>
/// The end-to-end authorization suite: login → assignment → role-owned gates
/// (routing, wrong-role rejection, concurrency, acting role) → knowledge
/// isolation → runtime-connection privacy → pool policy resolution → audit.
/// Runs against the real API pipeline over an InMemory database.
/// </summary>
public class PlatformApiTests : IClassFixture<PlatformApiTests.Factory>
{
    public sealed class Factory : WebApplicationFactory<Program>
    {
        static Factory()
        {
            // WebApplicationBuilder resolves the environment before the factory's UseEnvironment applies,
            // so the seed is triggered through its explicit switch instead.
            Environment.SetEnvironmentVariable("STA_RUN_MIGRATIONS", "1");
            Environment.SetEnvironmentVariable("STA_ADMIN_PASSWORD", "test-admin-pass-123");
        }

        /// <summary>A shared root makes every InMemory context in the process hit the same store, whatever provider instance they come from.</summary>
        internal static readonly InMemoryDatabaseRoot DatabaseRoot = new();

        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            builder.UseEnvironment("Development");
            builder.UseSetting("ConnectionStrings:Default", "Host=localhost;Database=unused;Username=u;Password=p");
            builder.UseSetting("Jwt:Secret", "test-secret-0123456789abcdef0123456789abcdef");
            // A dead STA target: port 1 refuses connections, so proxy behavior in tests is deterministic.
            builder.UseSetting("StaCore:BaseUrl", "http://127.0.0.1:1");
            builder.UseSetting("StaCore:Token", "test-token");
            builder.ConfigureServices(services =>
            {
                // Replace the Npgsql registration wholesale (options + EF 9+ provider-configuration descriptors).
                foreach (var descriptor in services.Where(d =>
                    d.ServiceType == typeof(Microsoft.EntityFrameworkCore.DbContextOptions<AppDbContext>) ||
                    d.ServiceType == typeof(Microsoft.EntityFrameworkCore.Infrastructure.IDbContextOptionsConfiguration<AppDbContext>) ||
                    d.ServiceType == typeof(StaPlatform.Application.Common.IAppDbContext)).ToList())
                {
                    services.Remove(descriptor);
                }
                services.AddDbContext<AppDbContext>(options => options.UseInMemoryDatabase("sta-platform-tests", Factory.DatabaseRoot));
                services.AddScoped<StaPlatform.Application.Common.IAppDbContext>(sp => sp.GetRequiredService<AppDbContext>());
            });
        }
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly Factory _factory;
    private readonly HttpClient _client;
    private string _adminToken = "";

    public PlatformApiTests(Factory factory)
    {
        _factory = factory;
        // Tests authenticate explicitly with Bearer tokens; the ambient login cookies must never ride along.
        _client = factory.CreateDefaultClient(new StripCookiesHandler());
    }

    private sealed class StripCookiesHandler : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            request.Headers.Remove("Cookie");
            return base.SendAsync(request, cancellationToken);
        }
    }

    // ───────────────────────── helpers ─────────────────────────

    private async Task<JsonElement> SendAsync(HttpMethod method, string path, object? body = null, string? token = null)
    {
        using var request = new HttpRequestMessage(method, path);
        var bearer = token ?? _adminToken;
        if (bearer.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        using var response = await _client.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True((int)response.StatusCode < 500, $"unexpected 5xx on {method} {path}: {text}");
        return JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text).RootElement.Clone();
    }

    private Task<JsonElement> GetAsync(string path, string? token = null) => SendAsync(HttpMethod.Get, path, null, token);
    private Task<JsonElement> PostAsync(string path, object? body = null, string? token = null) => SendAsync(HttpMethod.Post, path, body, token);
    private Task<JsonElement> PutAsync(string path, object? body = null, string? token = null) => SendAsync(HttpMethod.Put, path, body, token);
    private Task<JsonElement> DeleteAsync(string path, string? token = null) => SendAsync(HttpMethod.Delete, path, null, token);

    private static int Id(JsonElement e)
    {
        if (!e.TryGetProperty("id", out var id)) Assert.Fail($"missing id in: {e.GetRawText()}");
        return id.GetInt32();
    }

    private record MemberSpec(string Email, string Name, string Password, params (string Role, string Module)[] Assignments);

    /// <summary>One team on one Knowledge: Somchai (SA+DevLead), May (BA+PM), Ton (QA) — the spec's example trio (§23). Unique per test so the shared in-memory store never collides.</summary>
    private async Task<(int KnowledgeId, Dictionary<string, string> Tokens, int MayUserId)> SeedTeamAsync(string module = "timetableai")
    {
        var key = Guid.NewGuid().ToString("N")[..8];
        var knowledgeName = $"timetable-{key}";
        _adminToken = (await LoginAsync("admin@sta.local", "test-admin-pass-123"))!;
        var knowledge = await PostAsync("/api/knowledge", new { name = knowledgeName, registerOnStaMachine = false });
        var knowledgeId = Id(knowledge);

        var members = new List<MemberSpec>
        {
            new($"somchai.{key}@test.local", "Somchai", "somchai-pass-1", ("sa", module), ("dev_lead", module)),
            new($"may.{key}@test.local", "May", "may-pass-123456", ("ba", module), ("pm", module)),
            new($"ton.{key}@test.local", "Ton", "ton-pass-123456", ("qa", module)),
        };
        var tokens = new Dictionary<string, string>();
        var mayUserId = 0;
        foreach (var member in members)
        {
            var me = await GetAsync("/api/auth/me");
            if (!me.GetProperty("isOrgAdmin").GetBoolean()) Assert.Fail($"not admin before {member.Email}: {me.GetRawText()}");
            var invited = await PostAsync("/api/users", new { email = member.Email, name = member.Name, password = member.Password });
            if (!invited.TryGetProperty("id", out _)) Assert.Fail($"invite failed for {member.Email}: {invited.GetRawText()}");
            var userId = Id(await GetAsync($"/api/users/by-email/{member.Email}"));
            if (member.Name == "May") mayUserId = userId;
            await PostAsync($"/api/knowledge/{knowledgeId}/members", new { userId });
            await PutAsync($"/api/users/{userId}/assignments", new
            {
                assignments = member.Assignments.Select(a => new { role = a.Role, knowledgeId, module = a.Module }).ToArray(),
            });
            tokens[member.Name] = (await LoginAsync(member.Email, member.Password))!;
        }
        return (knowledgeId, tokens, mayUserId);
    }

    private async Task<string?> LoginAsync(string email, string password)
    {
        var response = await PostAsync("/api/auth/login", new { email, password });
        if (!response.TryGetProperty("accessToken", out var token))
            Assert.Fail($"login failed for {email}: {response.GetRawText()}");
        return token.GetString();
    }

    // ───────────────────────── auth ─────────────────────────

    [Fact]
    public async Task Health_is_anonymous_and_the_API_requires_a_session()
    {
        var health = await GetAsync("/api/meta/health");
        Assert.True(health.GetProperty("ok").GetBoolean());

        var anonymous = await _client.GetAsync("/api/gates/mine");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
    }

    [Fact]
    public async Task Login_rejects_a_wrong_password_with_401()
    {
        var response = await _client.PostAsJsonAsync("/api/auth/login", new { email = "admin@sta.local", password = "wrong" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Login_returns_identity_and_the_default_admin_is_org_admin()
    {
        _adminToken = (await LoginAsync("admin@sta.local", "test-admin-pass-123"))!;
        Assert.False(string.IsNullOrEmpty(_adminToken));
        var me = await GetAsync("/api/auth/me");
        Assert.True(me.GetProperty("isOrgAdmin").GetBoolean());
    }

    // ───────────────────────── assignments & effective roles ─────────────────────────

    [Fact]
    public async Task Effective_roles_resolve_through_the_scope_ladder()
    {
        var (knowledgeId, tokens, _) = await SeedTeamAsync();
        var somchai = tokens["Somchai"];
        var roles = await GetAsync($"/api/me/roles?knowledgeId={knowledgeId}&module=timetableai", somchai);
        var names = roles.GetProperty("roles").EnumerateArray().Select(r => r.GetString() ?? "").ToHashSet();
        Assert.Subset(names, new HashSet<string> { "sa", "dev_lead" });
        Assert.DoesNotContain("qa", names);
    }

    [Fact]
    public async Task Org_admin_only_endpoints_refuse_members()
    {
        var (_, tokens, _) = await SeedTeamAsync();
        var response = await _client.GetAsync("/api/users");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var asSomchai = await SendAsyncRaw(HttpMethod.Get, "/api/users", token: tokens["Somchai"]);
        Assert.Equal(HttpStatusCode.Forbidden, asSomchai);
    }

    [Fact]
    public async Task Membership_revocation_is_immediate()
    {
        var (knowledgeId, tokens, mayId) = await SeedTeamAsync();
        await DeleteAsync($"/api/knowledge/{knowledgeId}/members/{mayId}");

        // May's role row still exists, but the membership is gone: no gate visibility, no run access.
        var gates = await GetAsync("/api/gates/mine", tokens["May"]);
        Assert.Equal(JsonValueKind.Array, gates.ValueKind);
        var roles = await GetAsync($"/api/me/roles?knowledgeId={knowledgeId}&module=timetableai", tokens["May"]);
        Assert.Empty(roles.GetProperty("roles").EnumerateArray());
        _ = knowledgeId;
    }

    // ───────────────────────── role-owned gates ─────────────────────────

    [Fact]
    public async Task A_gate_routes_to_the_role_owner_and_only_that_role_can_answer_it()
    {
        var (knowledgeId, tokens, _) = await SeedTeamAsync();

        // The architecture gate (spec §25): required role = sa, routed by gate_policies.
        var gate = await PostAsync("/api/gates", new
        {
            gateType = "ARCHITECTURE_DECISION",
            knowledgeId,
            module = "timetableai",
            question = "normalized tables หรือ JSON rule model?",
            aiAnalysis = "trade-offs วิเคราะห์แล้ว",
            routingMode = "any_authorized",
        });
        Assert.Equal("sa", gate.GetProperty("requiredRole").GetString());
        Assert.Equal("Somchai", gate.GetProperty("assigneeName").GetString());
        var gateId = Id(gate);
        var asSomchai = await GetAsync($"/api/gates/{gateId}", tokens["Somchai"]);
        Assert.True(asSomchai.GetProperty("gate").GetProperty("canAnswer").GetBoolean());

        // The BA can see the inbox but the backend refuses her answer (spec §16).
        var wrong = await SendAsyncRaw(HttpMethod.Post, $"/api/gates/{gateId}/answer",
            body: new { approved = true, comment = "ผมตอบแทน" }, token: tokens["May"]);
        Assert.Equal(HttpStatusCode.Forbidden, wrong);

        // Somchai answers as the SA; the acting role is recorded (spec §14).
        var answered = await PostAsync($"/api/gates/{gateId}/answer", new { approved = true, comment = "ใช้ normalized tables" }, tokens["Somchai"]);
        Assert.Equal("Answered", answered.GetProperty("status").GetString());
        Assert.Equal("sa", answered.GetProperty("actingRole").GetString());
        Assert.Equal("Somchai", answered.GetProperty("answeredByName").GetString());

        // A second answer loses the race: the gate is already answered (spec §83).
        var late = await SendAsyncRaw(HttpMethod.Post, $"/api/gates/{gateId}/answer", body: new { approved = true }, token: tokens["Somchai"]);
        Assert.Equal(HttpStatusCode.Conflict, late);
    }

    [Fact]
    public async Task An_answered_review_gate_routes_to_reviewer_and_falls_back_to_creator_visibility()
    {
        var (knowledgeId, tokens, _) = await SeedTeamAsync();

        // REVIEW policy = reviewer; nobody holds reviewer yet → the gate waits open.
        var gate = await PostAsync("/api/gates", new
        {
            gateType = "REVIEW",
            knowledgeId,
            module = "timetableai",
            question = "พร้อมส่งต่อหรือยัง?",
        });
        Assert.Equal("reviewer", gate.GetProperty("requiredRole").GetString());
        Assert.Equal("Open", gate.GetProperty("status").GetString());
        var gateId = Id(gate);

        var wrong = await SendAsyncRaw(HttpMethod.Post, $"/api/gates/{gateId}/answer", body: new { approved = true }, token: tokens["Ton"]);
        Assert.Equal(HttpStatusCode.Forbidden, wrong);
    }

    [Fact]
    public async Task An_operational_gate_belongs_to_its_assignee_and_records_their_acting_role()
    {
        var (knowledgeId, tokens, mayId) = await SeedTeamAsync();

        var gate = await PostAsync("/api/gates", new
        {
            gateType = "OPERATIONAL",
            knowledgeId,
            question = "run หยุดกลางทาง — ตรวจแล้วดำเนินการต่อไหม",
            routingMode = "specific_assignee",
            assigneeId = mayId,
        });
        var gateId = Id(gate);

        var answered = await PostAsync($"/api/gates/{gateId}/answer", new { choice = "acknowledge", comment = "ดูแล้ว" }, tokens["May"]);
        Assert.Equal("assignee", answered.GetProperty("actingRole").GetString());

        var counts = await GetAsync("/api/gates/counts", tokens["May"]);
        Assert.Equal(JsonValueKind.Object, counts.ValueKind);
    }

    [Fact]
    public async Task Gate_inbox_shows_only_the_holders_own_knowledge()
    {
        var (_, tokens, _) = await SeedTeamAsync();

        // A second Knowledge with nobody in it: Somchai is not a member, must not see its gates.
        var other = await PostAsync("/api/knowledge", new { name = $"accounting-{Guid.NewGuid():N}".Substring(0, 20), registerOnStaMachine = false });
        var otherId = Id(other);
        await PostAsync("/api/gates", new { gateType = "ARCHITECTURE_DECISION", knowledgeId = otherId, question = "q" });

        var somchaiGates = await GetAsync("/api/gates/mine", tokens["Somchai"]);
        Assert.DoesNotContain(somchaiGates.EnumerateArray(), g => g.GetProperty("knowledgeName").GetString()!.StartsWith("accounting"));
    }

    // ───────────────────────── runtime connections & pools ─────────────────────────

    [Fact]
    public async Task Private_connections_stay_private_and_never_leak()
    {
        var (knowledgeId, tokens, _) = await SeedTeamAsync();
        var somchai = tokens["Somchai"];
        var ton = tokens["Ton"];

        await PostAsync("/api/me/connections", new { runtimeType = "claude-code" }, somchai);
        var duplicate = await SendAsyncRaw(HttpMethod.Post, "/api/me/connections", body: new { runtimeType = "claude" }, token: somchai);
        Assert.Equal(HttpStatusCode.Conflict, duplicate);

        var mine = await GetAsync("/api/me/connections", somchai);
        Assert.Contains(mine.EnumerateArray(), c => c.GetProperty("runtimeType").GetString() == "claude_code");
        Assert.Equal("Private", mine[0].GetProperty("sharingScope").GetString());

        var tons = await GetAsync("/api/me/connections", ton);
        Assert.DoesNotContain(tons.EnumerateArray(), c => c.GetProperty("ownerType").GetString() == "User");
    }

    [Fact]
    public async Task Pool_resolution_follows_the_policy_and_never_borrows_someone_elses_private_connection()
    {
        var (knowledgeId, tokens, _) = await SeedTeamAsync();
        var somchai = tokens["Somchai"];
        var ton = tokens["Ton"];
        await PostAsync("/api/me/connections", new { runtimeType = "claude-code" }, somchai);
        // Ton's private pool must never serve Somchai's work:
        await PostAsync("/api/me/connections", new { runtimeType = "codex" }, ton);
        await PostAsync("/api/pools/connections", new { runtimeType = "codex", ownerType = "knowledge", ownerId = knowledgeId, sharingScope = "knowledge_members" });
        await PostAsync("/api/pools/connections", new { runtimeType = "zcode", ownerType = "organization", ownerId = 1, sharingScope = "organization" });

        var ordered = await GetAsync($"/api/pools/resolve?knowledgeId={knowledgeId}&module=timetableai&role=engineer&policy=USER_KNOWLEDGE_ORG", somchai);
        Assert.Equal("Somchai", ordered.GetProperty("responsibleUserName").GetString());
        var tiers = ordered.GetProperty("order").EnumerateArray()
            .Select(r => $"{r.GetProperty("runtimeType").GetString()}:{r.GetProperty("poolTier").GetString()}").ToArray();
        Assert.Equal(new[] { "claude_code:user", "codex:knowledge", "zcode:organization" }, tiers);

        var privateOnly = await GetAsync($"/api/pools/resolve?knowledgeId={knowledgeId}&module=timetableai&role=engineer&policy=PRIVATE_ONLY", somchai);
        var only = privateOnly.GetProperty("order").EnumerateArray().Select(r => r.GetProperty("poolTier").GetString()).ToArray();
        Assert.Equal(new[] { "user" }, only);

        var sharedOnly = await GetAsync($"/api/pools/resolve?knowledgeId={knowledgeId}&module=timetableai&role=qa&policy=SHARED_ONLY", somchai);
        Assert.DoesNotContain(sharedOnly.GetProperty("order").EnumerateArray(), r => r.GetProperty("poolTier").GetString() == "user");
    }

    // ───────────────────────── audit ─────────────────────────

    [Fact]
    public async Task Diff_and_prepare_commit_are_proxied_only_for_members()
    {
        var (knowledgeId, tokens, _) = await SeedTeamAsync();
        var staRunId = "wr-diff-test-001";
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.WorkRuns.Add(new WorkRun
            {
                OrganizationId = 1,
                StaRunId = staRunId,
                KnowledgeId = knowledgeId,
                Module = "timetableai",
                LastStatus = "READY_FOR_REVIEW",
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        // A member passes authorization and reaches the proxy; STA is unreachable in tests, so the 502 names the fix.
        var asSomchai = await SendAsyncRaw(HttpMethod.Get, $"/api/runs/{staRunId}/diff", token: tokens["Somchai"]);
        Assert.Equal(HttpStatusCode.BadGateway, asSomchai);
        var prep = await SendAsyncRaw(HttpMethod.Get, $"/api/runs/{staRunId}/prepare-commit", token: tokens["Somchai"]);
        Assert.Equal(HttpStatusCode.BadGateway, prep);

        // An outsider never gets that far: the run belongs to a Knowledge they hold no membership in.
        var key = Guid.NewGuid().ToString("N")[..8];
        await PostAsync("/api/users", new { email = $"out.{key}@test.local", name = "Outsider", password = "outsider-pass-1" });
        var outsider = (await LoginAsync($"out.{key}@test.local", "outsider-pass-1"))!;
        var asOutsider = await SendAsyncRaw(HttpMethod.Get, $"/api/runs/{staRunId}/diff", token: outsider);
        Assert.Equal(HttpStatusCode.Forbidden, asOutsider);

        // Unknown run → 404, not a proxy error.
        var unknown = await SendAsyncRaw(HttpMethod.Get, "/api/runs/wr-none/diff");
        Assert.Equal(HttpStatusCode.NotFound, unknown);
    }

    [Fact]
    public async Task The_audit_log_records_the_authorization_story()
    {
        var (knowledgeId, tokens, _) = await SeedTeamAsync();

        // Perform one of each auditable act, then read the trail.
        var gate = await PostAsync("/api/gates", new { gateType = "ARCHITECTURE_DECISION", knowledgeId, module = "timetableai", question = "q?" });
        await PostAsync($"/api/gates/{Id(gate)}/answer", new { approved = true, comment = "ok" }, tokens["Somchai"]);
        await PostAsync("/api/me/connections", new { runtimeType = "zcode" }, tokens["Somchai"]);

        var audit = await GetAsync("/api/audit?limit=200");
        var actions = audit.EnumerateArray().Select(a => a.GetProperty("action").GetString() ?? "").ToHashSet();
        foreach (var expectedAction in new[] { "user.invited", "role.assigned", "gate.created", "gate.answered", "runtime.connected", "knowledge.created", "assignment.changed" })
            Assert.True(actions.Contains(expectedAction), $"missing {expectedAction} in [{string.Join(", ", actions)}]");
    }

    // ───────────────────────── plumbing ─────────────────────────

    private async Task<HttpStatusCode> SendAsyncRaw(HttpMethod method, string path, object? body = null, string? token = null)
    {
        using var request = new HttpRequestMessage(method, path);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        else if (_adminToken.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _adminToken);
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        using var response = await _client.SendAsync(request);
        return response.StatusCode;
    }
}
