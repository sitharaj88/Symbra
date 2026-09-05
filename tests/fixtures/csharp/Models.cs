namespace Acme.Models;

/// <summary>A user.</summary>
public class User
{
    public string Name { get; set; } = "";
    public void Normalize() { }
}

public record Employee(string Name, int Age)
{
    public string Display => Name;
}
