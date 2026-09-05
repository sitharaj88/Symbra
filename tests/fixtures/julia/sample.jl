"""
Sample module for extractor tests.
"""
module UserService

using Base: something
using App.Store: find_row, save_row
import App.Config
include("helpers.jl")

export find_user, User

"""
A user record.
"""
struct User
    id::Int
    name::String
end

mutable struct Cache
    entries::Dict{Int,User}
    hits::Int
end

"Any storable thing."
abstract type Storable end

struct Row <: Storable
    key::Int
end

const MAX_RETRIES = 3

macro trace(ex)
    return ex
end

"""
Find a user by id.
"""
function find_user(table::Dict{Int,User}, uid::Int)
    return get(table, uid, nothing)
end

function find_user(cache::Cache, uid::Int)
    return find_user(cache.entries, uid)
end

normalize(s::String) = lowercase(s)

render_user(u::User) = normalize(u.name)

function api_token()
    return ENV["API_TOKEN"]
end

function optional_token()
    return get(ENV, "OPTIONAL_TOKEN", "")
end

@trace function traced()
    return 1
end

end # module
