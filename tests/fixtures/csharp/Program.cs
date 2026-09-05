using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => "ok");
app.MapPost("/users", CreateUser);
app.Run();

static string CreateUser() => "created";
