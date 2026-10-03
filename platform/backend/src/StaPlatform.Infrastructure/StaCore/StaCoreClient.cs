using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StaPlatform.Application.Sta;

namespace StaPlatform.Infrastructure.StaCore;

public class StaCoreOptions
{
    public const string Section = "StaCore";
    /// <summary>Explicit base URL; when empty, port comes from the STA Core service record.</summary>
    public string? BaseUrl { get; set; }
    /// <summary>Explicit path of `core/service.json`; when empty, the default STA Core home is used.</summary>
    public string? ServiceRecordPath { get; set; }
    /// <summary>Explicit x-sta-token; when empty, read from the service record.</summary>
    public string? Token { get; set; }
    public int TimeoutSeconds { get; set; } = 60;
}

/// <summary>STA Core's service record (`core/service.json`): written per start, mode 0600, machine-local.</summary>
public record StaServiceRecord(int Pid, int Port, string Token, string StartedAt, string Version);

public record StaServiceInfo(string BaseUrl, string Token);

/// <summary>
/// The one door from the platform into STA Core's Local API — the same door
/// the STA Web UI and the `sta work` CLI use. Authentication is STA's
/// machine-local service token; nothing here bypasses STA's own rules.
/// </summary>
public class StaCoreClient(IHttpClientFactory httpClientFactory, IOptions<StaCoreOptions> options, ILogger<StaCoreClient> logger) : IStaCoreClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly StaCoreOptions _options = options.Value;
    private (StaServiceInfo Info, DateTime ReadAt)? _cached;

    public async Task<bool> PingAsync(CancellationToken ct = default)
    {
        try
        {
            using var response = await SendAsync(HttpMethod.Get, "health", null, ct);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<IReadOnlyList<StaKnowledgeInfo>> ListKnowledgeAsync(CancellationToken ct = default)
        => await GetAsync<List<StaKnowledgeInfo>>("knowledge", ct) ?? [];

    public Task<StaKnowledgeModules?> ListModulesAsync(string knowledgeName, CancellationToken ct = default)
        => GetAsync<StaKnowledgeModules>($"knowledge/{Uri.EscapeDataString(knowledgeName)}/modules", ct);

    public async Task<IReadOnlyList<StaRunSummary>> ListRunsAsync(string? status = null, string? knowledge = null, string? module = null, CancellationToken ct = default)
    {
        var query = new List<string>();
        if (status is not null) query.Add($"status={Uri.EscapeDataString(status)}");
        if (knowledge is not null) query.Add($"knowledge={Uri.EscapeDataString(knowledge)}");
        if (module is not null) query.Add($"module={Uri.EscapeDataString(module)}");
        var path = "runs" + (query.Count > 0 ? $"?{string.Join('&', query)}" : "");
        return await GetAsync<List<StaRunSummary>>(path, ct) ?? [];
    }

    public Task<StaRunDetail?> GetRunAsync(string runId, CancellationToken ct = default)
        => GetAsync<StaRunDetail>($"runs/{Uri.EscapeDataString(runId)}", ct);

    public Task<StaRunDiff?> GetRunDiffAsync(string runId, CancellationToken ct = default)
        => GetAsync<StaRunDiff>($"runs/{Uri.EscapeDataString(runId)}/diff", ct);

    public Task<StaPrepareCommit?> GetPrepareCommitAsync(string runId, CancellationToken ct = default)
        => GetAsync<StaPrepareCommit>($"runs/{Uri.EscapeDataString(runId)}/prepare-commit", ct);

    public async Task<StaCreateRunResult?> CreateRunAsync(string knowledge, string module, string commandText, CancellationToken ct = default)
        => await PostAsync<StaCreateRunResult>("runs", new { knowledge, module, text = commandText }, ct);

    public Task<StaRunDetail?> PauseAsync(string runId, CancellationToken ct = default)
        => PostAsync<StaRunDetail>($"runs/{Uri.EscapeDataString(runId)}/pause", new { }, ct);

    public Task<StaRunDetail?> ResumeAsync(string runId, CancellationToken ct = default)
        => PostAsync<StaRunDetail>($"runs/{Uri.EscapeDataString(runId)}/resume", new { }, ct);

    public Task<StaRunDetail?> StopAsync(string runId, bool force = false, CancellationToken ct = default)
        => PostAsync<StaRunDetail>($"runs/{Uri.EscapeDataString(runId)}/stop", new { force }, ct);

    public Task<StaRunDetail?> ApproveAsync(string runId, string by, string? note, CancellationToken ct = default)
        => PostAsync<StaRunDetail>($"runs/{Uri.EscapeDataString(runId)}/approve", new { by, note }, ct);

    public Task<StaRunDetail?> SendBackAsync(string runId, string by, string note, CancellationToken ct = default)
        => PostAsync<StaRunDetail>($"runs/{Uri.EscapeDataString(runId)}/send-back", new { by, note }, ct);

    public async Task<StaRuntimes?> ListRuntimesAsync(CancellationToken ct = default)
        => await GetAsync<StaRuntimes>("runtimes", ct);

    public async Task<IReadOnlyList<StaEngineApproval>> ListEngineApprovalsAsync(string runId, CancellationToken ct = default)
    {
        var result = await GetAsync<StaApprovalList>($"runs/{Uri.EscapeDataString(runId)}/approvals", ct);
        return result?.Approvals ?? [];
    }

    public Task AnswerEngineApprovalAsync(string runId, string requestId, string taskId, bool approved, string by, string? note, CancellationToken ct = default)
        => PostAsync<object>($"runs/{Uri.EscapeDataString(runId)}/approvals/{Uri.EscapeDataString(requestId)}/answer", new { approved, by, note, taskId }, ct);

    // ───────────────────────── plumbing ─────────────────────────

    private async Task<T?> GetAsync<T>(string path, CancellationToken ct)
    {
        using var response = await SendAsync(HttpMethod.Get, path, null, ct);
        return await ReadAsync<T>(response, ct);
    }

    private async Task<T?> PostAsync<T>(string path, object body, CancellationToken ct)
    {
        using var response = await SendAsync(HttpMethod.Post, path, body, ct);
        return await ReadAsync<T>(response, ct);
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var info = Resolve();
        var client = httpClientFactory.CreateClient("sta-core");
        client.BaseAddress = new Uri(info.BaseUrl);
        client.Timeout = TimeSpan.FromSeconds(_options.TimeoutSeconds);
        var request = new HttpRequestMessage(method, $"/api/{path}");
        request.Headers.Add("x-sta-token", info.Token);
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body, Json), System.Text.Encoding.UTF8, "application/json");
        var response = await SendCoreAsync(client, request, ct);
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            logger.LogInformation("STA Core {Method} /api/{Path} → {Status}: {Body}", method, path, (int)response.StatusCode, text);
            // STA's own error message travels to the caller: rules live in STA Core, the platform relays them.
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                throw new StaCoreNotFoundException(ExtractError(text) ?? $"STA Core หา {path} ไม่พบ");
            throw new StaCoreException(ExtractError(text) ?? $"STA Core ตอบ {response.StatusCode} สำหรับ {path}");
        }
        return response;
    }

    private async Task<HttpResponseMessage> SendCoreAsync(HttpClient client, HttpRequestMessage request, CancellationToken ct)
    {
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, ct);
        }
        catch (HttpRequestException error)
        {
            throw new StaCoreException($"STA Core ไม่ตอบสนอง — ตรวจว่า `sta start` ทำงานอยู่ ({error.Message})");
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new StaCoreException($"STA Core ไม่ตอบภายใน {_options.TimeoutSeconds} วินาที");
        }
        return response;
    }

    private static string? ExtractError(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(body, Json);
            return parsed is not null && parsed.TryGetValue("error", out var error) && error.ValueKind == JsonValueKind.String
                ? error.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    private static async Task<T?> ReadAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        var text = await response.Content.ReadAsStringAsync(ct);
        if (string.IsNullOrWhiteSpace(text)) return default;
        try
        {
            return JsonSerializer.Deserialize<T>(text, Json);
        }
        catch (JsonException error)
        {
            throw new StaCoreException($"STA Core ตอบกลับมาในรูปแบบที่ไม่คาดคิด: {error.Message}");
        }
    }

    internal StaServiceInfo Resolve()
    {
        if (_cached is { } cache && DateTime.UtcNow - cache.ReadAt < TimeSpan.FromSeconds(5)) return cache.Info;
        var info = ResolveOnce();
        _cached = (info, DateTime.UtcNow);
        return info;
    }

    private StaServiceInfo ResolveOnce()
    {
        if (_options.Token is not null && _options.BaseUrl is not null)
            return new StaServiceInfo(_options.BaseUrl, _options.Token);

        var recordPath = _options.ServiceRecordPath ?? DefaultServiceRecordPath();
        if (recordPath is not null && File.Exists(recordPath))
        {
            try
            {
                var record = JsonSerializer.Deserialize<StaServiceRecord>(File.ReadAllText(recordPath), Json);
                if (record is not null && !string.IsNullOrEmpty(record.Token))
                {
                    var baseUrl = _options.BaseUrl ?? $"http://127.0.0.1:{record.Port}";
                    var token = _options.Token ?? record.Token;
                    return new StaServiceInfo(baseUrl, token);
                }
            }
            catch (Exception error)
            {
                logger.LogWarning(error, "cannot read the STA Core service record at {Path}", recordPath);
            }
        }

        var fallbackUrl = _options.BaseUrl ?? "http://127.0.0.1:4317";
        var fallbackToken = _options.Token ?? "";
        if (fallbackToken.Length == 0)
            logger.LogWarning("no STA Core service token available — set StaCore:Token or run `sta start` first");
        return new StaServiceInfo(fallbackUrl, fallbackToken);
    }

    internal static string? DefaultServiceRecordPath()
    {
        var home = StaCoreHome();
        return home is null ? null : Path.Combine(home, "core", "service.json");
    }

    internal static string? StaCoreHome()
    {
        var env = Environment.GetEnvironmentVariable("STA_CORE_HOME");
        if (!string.IsNullOrWhiteSpace(env)) return env;
        if (OperatingSystem.IsWindows())
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return string.IsNullOrEmpty(localAppData) ? null : Path.Combine(localAppData, "software-team-agents");
        }
        var configHome = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        var baseDir = string.IsNullOrWhiteSpace(configHome)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config")
            : configHome;
        return Path.Combine(baseDir, "software-team-agents");
    }
}

public class StaCoreException(string message) : Exception(message);

public class StaCoreNotFoundException(string message) : StaCoreException(message);
