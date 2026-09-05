package com.example.repo

/** Specification for UserRepo. */
class UserRepoSpec extends Specification {
    def "finds a user by id"() {
        expect:
        new UserRepo(null).find(1) != null
    }
}
