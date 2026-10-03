using StaPlatform.Infrastructure.Identity;
using Xunit;

namespace StaPlatform.Tests.Unit;

public class Pbkdf2PasswordHasherTests
{
    private readonly Pbkdf2PasswordHasher _hasher = new();

    [Fact]
    public void Hash_then_Verify_roundtrips()
    {
        var hash = _hasher.Hash("correct horse battery");
        Assert.StartsWith("PBKDF2$", hash);
        Assert.True(_hasher.Verify("correct horse battery", hash));
    }

    [Fact]
    public void Wrong_password_is_rejected()
    {
        var hash = _hasher.Hash("correct horse battery");
        Assert.False(_hasher.Verify("wrong horse", hash));
    }

    [Fact]
    public void Same_password_hashes_differently_each_time()
    {
        var a = _hasher.Hash("same-password-1");
        var b = _hasher.Hash("same-password-1");
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void Corrupted_hash_is_rejected_not_thrown()
    {
        Assert.False(_hasher.Verify("whatever", "not-a-hash"));
        Assert.False(_hasher.Verify("whatever", "PBKDF2$abc$zz$$"));
    }
}

public class JwtTokenServiceTests
{
    private readonly JwtTokenService _tokens = new(new JwtOptions
    {
        Secret = "unit-test-secret-0123456789abcdef0123456789",
        Issuer = "sta-test",
        Audience = "sta-test-web",
    });

    [Fact]
    public void Access_token_carries_identity_and_org_claims()
    {
        var (token, expires) = _tokens.CreateAccessToken(42, "a@b.c", "Somchai", 1, isOrgAdmin: true);
        Assert.True(expires > DateTime.UtcNow);

        var handler = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler();
        var jwt = handler.ReadJwtToken(token);
        Assert.Equal("42", jwt.Subject);
        Assert.Equal("a@b.c", jwt.Claims.First(c => c.Type == "email").Value);
        Assert.Equal("Somchai", jwt.Claims.First(c => c.Type == "name").Value);
        Assert.Equal("1", jwt.Claims.First(c => c.Type == "org").Value);
        Assert.Equal("1", jwt.Claims.First(c => c.Type == "org_admin").Value);
    }

    [Fact]
    public void Refresh_tokens_are_unique_and_hashed_deterministically()
    {
        var (a, aHash) = _tokens.NewRefreshToken();
        var (b, bHash) = _tokens.NewRefreshToken();
        Assert.NotEqual(a, b);
        Assert.Equal(aHash, _tokens.HashRefreshToken(a));
        Assert.Equal(64, aHash.Length);
    }
}
