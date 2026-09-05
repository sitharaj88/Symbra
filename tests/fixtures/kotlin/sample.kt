/**
 * Sample Kotlin file for extractor tests.
 */
package com.acme.users

import java.util.Optional
import com.acme.util.Strings
import com.acme.util.*
import com.acme.util.Formatter as Fmt
import org.springframework.web.bind.annotation.GetMapping

const val MAX_RETRIES = 3
val logger = Logger()
var counter: Int = 0

/** Base repository. */
abstract class BaseRepo<T>(protected val session: Session) : Repository<T>, Closeable {
    private val cache: Cache = Cache()

    /**
     * Find one by id.
     */
    abstract fun find(id: String): Optional<T>

    override fun close() {
        session.close()
    }

    companion object {
        const val NAME = "base"
        fun create(): BaseRepo<Any> = TODO()
    }
}

/**
 * Finds users.
 */
@Service
class UserRepo(session: Session, private val strings: Strings) : BaseRepo<User>(session) {
    val size: Int
        get() = 0

    override fun find(id: String): Optional<User> {
        val user = session.get(id)
        val v = Validator(user)
        v.check()
        cache.put(user)
        val fmt: Fmt = Fmt()
        val key = System.getenv("API_TOKEN")
        return Optional.ofNullable(normalize(user))
    }

    private fun normalize(u: User): User = u
}

interface Repository<T> {
    fun find(id: String): Optional<T>
}

data class User(val id: String, var name: String)

enum class Color(val code: String) {
    RED("r"), GREEN("g");
    fun label() = code
}

sealed class Result {
    object Empty : Result()
    data class Ok(val value: Int) : Result()
}

object Registry {
    fun lookup(id: String): User? = null
}

typealias Handler = (String) -> Unit

fun String.slug(): String = lowercase()

@RestController
class UserController(private val repo: UserRepo) {
    @GetMapping("/users/{id}")
    fun getUser(@PathVariable id: String): User = repo.find(id).get()

    @PostMapping(value = ["/users"])
    fun createUser(@RequestBody user: User) {
        repo.save(user)
    }
}

fun Application.module() {
    routing {
        get("/health") {
            call.respondText("ok")
        }
        post("/items") { }
    }
}

class UserRepoTest {
    @Test
    fun `finds user`() {
        val repo = UserRepo(Session(), Strings())
        assertNotNull(repo.find("1"))
    }
}
