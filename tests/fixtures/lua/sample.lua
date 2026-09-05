--- Sample module.
local util = require("app.util")
local json = require "cjson"
local M = {}
local MAX_RETRIES = 3
COUNT = 0

--- Adds two numbers.
-- @param a number
function M.add(a, b)
  return a + b
end

--- Instance method.
function M:reset()
  self.count = 0
  return util.clamp(self.count, 0, 1)
end

M.sub = function(a, b) return a - b end
M.PI = 3.14

--- Local helper.
local function helper(x)
  return M.add(x, 1)
end

function globalFn(y)
  local r = helper(y)
  json.encode(r)
  M:reset()
  local obj = Widget.new()
  obj:draw()
  return r
end

local Widget = {}
Widget.__index = Widget
function Widget.new() return setmetatable({}, Widget) end
function Widget:draw() end

describe("M", function()
  it("adds", function()
    assert.equals(3, M.add(1, 2))
  end)
end)

return M
