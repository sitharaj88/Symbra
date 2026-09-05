using Test
include("sample.jl")

@testset "find_user" begin
    @test UserService.normalize("AB") == "ab"
    @test UserService.find_user(Dict{Int,UserService.User}(), 1) === nothing
end
