using System;
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;
using Xunit;
using Json = System.Text.Json.JsonSerializer;
using static System.Math;

namespace Acme.Services
{
    /// <summary>
    /// Base repository.
    /// </summary>
    public abstract class BaseRepo<T> : IDisposable
    {
        protected readonly List<T> items = new List<T>();
        public abstract void Dispose();
    }

    public interface IUserRepo
    {
        User Find(int id);
    }

    /// <summary>Repository for users.</summary>
    /// <remarks>Uses a session.</remarks>
    public class UserRepo : BaseRepo<User>, IUserRepo
    {
        private readonly Session session;
        private Cache cache;
        public int Count { get; set; }
        public static int MaxRetries = 3, Timeout = 10;
        public event EventHandler Changed;

        public UserRepo(Session session)
        {
            this.session = session;
            this.cache = new Cache();
        }

        /// <summary>Finds a user.</summary>
        public User Find(int id)
        {
            var user = session.Get<User>(id);
            User fallback = new User();
            Cache local = new();
            local.Warm();
            fallback.Normalize();
            var token = Environment.GetEnvironmentVariable("API_TOKEN");
            if (user is User u) return u;
            var t = typeof(Session);
            return fallback as User;
        }

        public override void Dispose() { cache.Clear(); }

        [Obsolete("use Find")]
        internal static string Normalize(string s)
        {
            int Helper(int x) { return x * 2; }
            return s.Trim();
        }
    }

    public struct Point { public int X; public int Y; }
    public record Person(string Name, int Age);
    public enum Color { Red, Green, Blue }
    public delegate void Handler(object sender);

    [ApiController]
    [Route("api/users")]
    public class UsersController : ControllerBase
    {
        [HttpGet("{id}")]
        public User Get(int id) => new User();

        [HttpPost]
        public void Create([FromBody] User u) { }
    }

    public class UserRepoTests
    {
        [Fact]
        public void FindReturnsUser()
        {
            var repo = new UserRepo(new Session());
            var u = repo.Find(1);
            Assert.NotNull(u);
        }

        [Theory]
        [InlineData(1)]
        public void FindTheory(int id) { }
    }
}
