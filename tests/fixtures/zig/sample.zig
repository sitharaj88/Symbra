//! Sample module.
const std = @import("std");
const util = @import("util.zig");
const Allocator = std.mem.Allocator;

/// Maximum retries.
pub const MAX_RETRIES: u32 = 3;
var counter: i32 = 0;

/// A user.
pub const User = struct {
    id: u32,
    name: []const u8,

    pub fn init(id: u32) User {
        return .{ .id = id, .name = "" };
    }

    pub fn greet(self: *const User, other: User) void {
        std.debug.print("{s}", .{self.name});
        helper(other.id);
    }
};

const Status = enum { active, inactive };
const Value = union(enum) { int: i32, str: []const u8 };
const Error = error{ NotFound, Bad };

fn helper(x: u32) u32 {
    return x + 1;
}

pub fn topLevel(alloc: Allocator, repo: *Repo) !void {
    const u = User.init(1);
    u.greet(u);
    var list = std.ArrayList(u8).init(alloc);
    defer list.deinit();
    const home = std.os.getenv("HOME");
    const tok = std.posix.getenv("API_TOKEN");
    _ = home; _ = tok; _ = repo;
    util.doThing();
    try repo.save(u);
}

test "helper adds one" {
    try std.testing.expect(helper(1) == 2);
}

test {
    _ = User;
}
