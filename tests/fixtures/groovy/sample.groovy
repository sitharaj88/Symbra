package com.example.repo

import groovy.transform.CompileStatic
import com.example.model.User

/** A base repository. */
abstract class BaseRepo {
    abstract User find(int id)
}

@CompileStatic
class UserRepo extends BaseRepo implements Repo {
    /** The backing session. */
    private Session session
    static final int MAX_RETRIES = 3

    UserRepo(Session session) {
        this.session = session
    }

    /** Find a user by id. */
    User find(int id) {
        Session local = session
        def cached = new User('anon')
        local.get(id)
        normalize(cached)
        return cached
    }

    private void normalize(User u) { }
}

interface Repo {
    User find(int id)
}

enum Status { ACTIVE, INACTIVE }

def topLevel(String name) {
    println name
    return System.getenv('API_TOKEN')
}

def handler = { msg -> msg }
