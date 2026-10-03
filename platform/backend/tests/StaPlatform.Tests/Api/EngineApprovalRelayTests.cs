using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using StaPlatform.Application.Common;
using StaPlatform.Application.Services;
using StaPlatform.Application.Sta;
using StaPlatform.Domain.Entities;
using StaPlatform.Infrastructure.Persistence;
using Xunit;

namespace StaPlatform.Tests.Api;

/// <summary>
/// The engine-approval relay, end to end against a FAKE STA Core: a waiting
/// run with a pending engine approval becomes a role-routed platform gate, the
/// authorized human answers it in the inbox, and the decision + resume travel
/// back to STA through the relay endpoints.
/// </summary>
public class EngineApprovalRelayTests : IClassFixture<EngineApprovalRelayTests.Factory>
{
    public sealed class Factory : WebApplicationFactory<Program>
    {
        static Factory()
        {
            Environment.SetEnvironmentVariable("STA_RUN_MIGRATIONS", "1");
            Environment.SetEnvironmentVariable("STA_ADMIN_PASSWORD", "test-admin-pass-123");
        }

        internal static readonly InMemoryDatabaseRoot DatabaseRoot = new();
        public FakeStaCoreClient Fake { get; } = new();

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Development");
            builder.UseSetting("ConnectionStrings:Default", "Host=localhost;Database=unused;Username=u;Password=p");
            builder.UseSetting("Jwt:Secret", "test-secret-0123456789abcdef0123456789abcdef");
            builder.ConfigureServices(services =>
            {
                foreach (var descriptor in services.Where(d =>
                    d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                    d.ServiceType == typeof(Microsoft.EntityFrameworkCore.Infrastructure.IDbContextOptionsConfiguration<AppDbContext>) ||
                    d.ServiceType == typeof(IAppDbContext) ||
                    d.ServiceType == typeof(IStaCoreClient)).ToList())
                {
                    services.Remove(descriptor);
                }
                services.AddDbContext<AppDbContext>(options => options.UseInMemoryDatabase("sta-relay-tests", DatabaseRoot));
                services.AddScoped<IAppDbContext>(sp => sp.GetRequiredService<AppDbContext>());
                services.AddSingleton<IStaCoreClient>(Fake);
            });
        }
    }

    /// <summary>A scripted STA Core: the platform's calls land here and are recorded for assertions.</summary>
    public sealed class FakeStaCoreClient : IStaCoreClient
    {
        public List<StaRunSummary> Runs { get; } = [];
        public Dictionary<string, StaRunDetail> Details { get; } = [];
        public Dictionary<string, List<StaEngineApproval>> Approvals { get; } = [];
        public List<(string RunId, string RequestId, string TaskId, bool Approved, string By, string? Note)> Answered { get; } = [];
        public int ResumeCalls { get; private set; }

        public Task<bool> PingAsync(CancellationToken ct = default) => Task.FromResult(true);

        public Task<IReadOnlyList<StaKnowledgeInfo>> ListKnowledgeAsync(CancellationToken ct = default)
            => Task.FromResult<IReadOnlyList<StaKnowledgeInfo>>([]);

        public Task<StaKnowledgeModules?> ListModulesAsync(string knowledgeName, CancellationToken ct = default)
            => Task.FromResult<StaKnowledgeModules?>(new StaKnowledgeModules { Knowledge = knowledgeName, Modules = ["timetableai"] });

        public Task<IReadOnlyList<StaRunSummary>> ListRunsAsync(string? status = null, string? knowledge = null, string? module = null, CancellationToken ct = default)
            => Task.FromResult<IReadOnlyList<StaRunSummary>>(Runs.ToList());

        public Task<StaRunDetail?> GetRunAsync(string runId, CancellationToken ct = default)
            => Task.FromResult(Details.GetValueOrDefault(runId));

        public Task<StaCreateRunResult?> CreateRunAsync(string knowledge, string module, string commandText, CancellationToken ct = default)
            => throw new InvalidOperationException("not scripted");

        public Task<StaRunDetail?> PauseAsync(string runId, CancellationToken ct = default) => Task.FromResult<StaRunDetail?>(null);
        public Task<StaRunDetail?> StopAsync(string runId, bool force = false, CancellationToken ct = default) => Task.FromResult<StaRunDetail?>(null);
        public Task<StaRunDetail?> ApproveAsync(string runId, string by, string? note, CancellationToken ct = default) => Task.FromResult<StaRunDetail?>(null);
        public Task<StaRunDetail?> SendBackAsync(string runId, string by, string note, CancellationToken ct = default) => Task.FromResult<StaRunDetail?>(null);
        public Task<StaRuntimes?> ListRuntimesAsync(CancellationToken ct = default) => Task.FromResult<StaRuntimes?>(new StaRuntimes());

        public Task<StaRunDiff?> GetRunDiffAsync(string runId, CancellationToken ct = default)
            => Task.FromResult<StaRunDiff?>(new StaRunDiff { Diff = "", Truncated = false });

        public Task<StaPrepareCommit?> GetPrepareCommitAsync(string runId, CancellationToken ct = default)
            => Task.FromResult<StaPrepareCommit?>(new StaPrepareCommit { Note = "", Commands = [] });

        public Task<StaRunDetail?> ResumeAsync(string runId, CancellationToken ct = default)
        {
            ResumeCalls++;
            return Task.FromResult<StaRunDetail?>(null);
        }

        public Task<IReadOnlyList<StaEngineApproval>> ListEngineApprovalsAsync(string runId, CancellationToken ct = default)
            => Task.FromResult<IReadOnlyList<StaEngineApproval>>(Approvals.GetValueOrDefault(runId) ?? []);

        public Task AnswerEngineApprovalAsync(string runId, string requestId, string taskId, bool approved, string by, string? note, CancellationToken ct = default)
        {
            Answered.Add((runId, requestId, taskId, approved, by, note));
            return Task.CompletedTask;
        }
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly Factory _factory;
    private readonly HttpClient _client;
    private string _adminToken = "";

    public EngineApprovalRelayTests(Factory factory)
    {
        _factory = factory;
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
    private static int Id(JsonElement e) => e.GetProperty("id").GetInt32();

    private async Task<string> LoginAsync(string email, string password)
    {
        var response = await PostAsync("/api/auth/login", new { email, password });
        if (!response.TryGetProperty("accessToken", out var token)) Assert.Fail($"login failed for {email}: {response.GetRawText()}");
        return token.GetString()!;
    }

    [Fact]
    public async Task Engine_approvals_route_to_role_owners_and_relay_answers_to_sta()
    {
        _adminToken = await LoginAsync("admin@sta.local", "test-admin-pass-123");

        // Seed the team (Somchai sa/dev_lead · May ba/pm · Ton qa) on its own Knowledge.
        var key = Guid.NewGuid().ToString("N")[..8];
        var knowledge = await PostAsync("/api/knowledge", new { name = $"relay-{key}", registerOnStaMachine = false });
        var knowledgeId = Id(knowledge);
        var knowledgeName = knowledge.GetProperty("name").GetString()!;
        foreach (var (email, name, password, roles) in new[]
                 {
                     (Email: $"somchai.{key}@test.local", Name: "Somchai", Password: "somchai-pass-1", Roles: new[] { "sa", "dev_lead" }),
                     (Email: $"may.{key}@test.local", Name: "May", Password: "may-pass-123456", Roles: new[] { "ba", "pm" }),
                     (Email: $"ton.{key}@test.local", Name: "Ton", Password: "ton-pass-123456", Roles: new[] { "qa" }),
                 })
        {
            await PostAsync("/api/users", new { email, name, password });
            var userId = Id(await GetAsync($"/api/users/by-email/{email}"));
            await PostAsync($"/api/knowledge/{knowledgeId}/members", new { userId });
            await PutAsync($"/api/users/{userId}/assignments", new
            {
                assignments = roles.Select(role => new { role, knowledgeId, module = "timetableai" }).ToArray(),
            });
        }
        var may = await LoginAsync($"may.{key}@test.local", "may-pass-123456");

        // The run is waiting on an engine approval (a requirement interview) — BA territory.
        var requestId = "apr_" + new string('a', 32);
        var fake = _factory.Fake;
        fake.Runs.Add(new StaRunSummary
        {
            RunId = "wr-relay-1",
            Knowledge = knowledgeName,
            Module = "timetableai",
            Status = "WAITING_FOR_HUMAN",
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
        fake.Details["wr-relay-1"] = new StaRunDetail
        {
            Run = new StaRun
            {
                RunId = "wr-relay-1",
                Knowledge = new StaKnowledgeRef { Name = knowledgeName, Path = @"C:\tmp\relay-knowledge" },
                Module = "timetableai",
                Status = "WAITING_FOR_HUMAN",
                HumanGates = [new StaHumanGate { Id = "g1", At = 0, Kind = "engine_waiting", Reason = "งานรอคนตัดสินใจ", ResolvedAt = null }],
            },
            RuntimeEvents = [],
        };
        fake.Approvals["wr-relay-1"] =
        [
            new StaEngineApproval
            {
                TaskId = "T-1",
                RequestId = requestId,
                Type = "requirement-interview",
                Reason = "วิชาเลือกชนกัน: เลือกอัตโนมัติหรือถามผู้ใช้?",
            },
        ];

        using (var scope = _factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<StaCoreSyncService>().SyncOnceAsync();

        // The gate routes to the BA — visible in May's inbox, answerable there.
        var gates = await GetAsync("/api/gates/mine", may);
        var gate = gates.EnumerateArray().FirstOrDefault(g => g.GetProperty("staRunId").GetString() == "wr-relay-1");
        Assert.False(gate.ValueKind == JsonValueKind.Undefined, "May should see the relayed approval gate");
        Assert.Equal("REQUIREMENT_DECISION", gate.GetProperty("gateType").GetString());
        Assert.Equal("ba", gate.GetProperty("requiredRole").GetString());
        Assert.Equal("Open", gate.GetProperty("status").GetString());
        Assert.True(gate.GetProperty("canAnswer").GetBoolean());
        var gateId = gate.GetProperty("id").GetInt32();

        // The creator-routed operational stand-in must NOT exist for this run.
        var adminGates = await GetAsync("/api/gates/mine", _adminToken);
        Assert.DoesNotContain(adminGates.EnumerateArray(),
            g => g.GetProperty("staRunId").GetString() == "wr-relay-1" && g.GetProperty("gateType").GetString() == "OPERATIONAL");

        // May answers — the decision relays into the engine and the run resumes.
        var answered = await PostAsync($"/api/gates/{gateId}/answer", new { approved = true, comment = "เลือกอัตโนมัติ" }, may);
        Assert.Equal("Answered", answered.GetProperty("status").GetString());
        Assert.Equal("ba", answered.GetProperty("actingRole").GetString());

        var entry = Assert.Single(fake.Answered);
        Assert.Equal("wr-relay-1", entry.RunId);
        Assert.Equal(requestId, entry.RequestId);
        Assert.Equal("T-1", entry.TaskId);
        Assert.True(entry.Approved);
        Assert.Equal("May", entry.By);
        Assert.Equal("เลือกอัตโนมัติ", entry.Note);
        Assert.Equal(1, fake.ResumeCalls);

        // Wrong role is refused before anything relays (BA answered already, so also 409 for late answers).
        var somchai = await LoginAsync($"somchai.{key}@test.local", "somchai-pass-1");
        var late = await _client.SendAsync(new HttpRequestMessage(HttpMethod.Post, $"/api/gates/{gateId}/answer")
        {
            Content = JsonContent.Create(new { approved = true }),
            Headers = { Authorization = new AuthenticationHeaderValue("Bearer", somchai) },
        });
        Assert.Equal(HttpStatusCode.Conflict, late.StatusCode);
        Assert.Single(fake.Answered);
    }
}
