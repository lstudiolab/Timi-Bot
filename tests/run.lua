package.path = "./?.lua;./?/init.lua;" .. package.path
local util = require("timi.util")

local function test(name, fn)
  local ok, err = pcall(fn)
  if not ok then
    io.stderr:write("FAIL " .. name .. ": " .. tostring(err) .. "\n")
    os.exit(1)
  end
  io.stdout:write("PASS " .. name .. "\n")
end

test("snowflake validation", function()
  assert(util.is_snowflake("123456789012345678"))
  assert(not util.is_snowflake("not-a-snowflake"))
  assert(not util.is_snowflake("123"))
end)

test("verification threshold policy", function()
  local function decision(score, too_young)
    if too_young then return "review" end
    if score >= 80 then return "pass" end
    if score >= 60 then return "review" end
    return "kick"
  end
  assert(decision(80, false) == "pass")
  assert(decision(60, false) == "review")
  assert(decision(59, false) == "kick")
  assert(decision(10, true) == "review")
end)

test("Jaccard similarity", function()
  assert(util.jaccard("same same", "same") == 1)
  assert(util.jaccard("one two", "three four") == 0)
end)

test("message normalization", function()
  assert(util.normalize_message("HELLO!!!  https://example.com <@123456789012345678>") == "hello url mention")
end)

test("permission flags do not imply administrator", function()
  local ordinary = {member = {permissions = "32"}}
  local admin = {member = {permissions = "8"}}
  assert(util.has_permission(ordinary, 32))
  assert(not util.has_permission(ordinary, 8192))
  assert(util.has_permission(admin, 8192))
end)

test("private ticket close confirmation controls", function()
  local confirm = util.button("ticket:confirm-close", "Yes, close it", 2)
  local cancel = util.button("ticket:cancel-close", "Cancel", 2)
  assert(confirm.custom_id == "ticket:confirm-close")
  assert(cancel.custom_id == "ticket:cancel-close")
end)

io.stdout:write("All Timi Lua tests passed.\n")
