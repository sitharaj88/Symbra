/**
 * Sample Java file for extractor tests.
 */
package com.acme.users;

import java.util.List;
import java.util.Optional;
import java.util.*;
import static java.util.Collections.emptyList;
import com.acme.util.Strings;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;

/** Base repository. */
public abstract class BaseRepo<T> implements Repository<T>, Closeable {
    /** Max retries. */
    public static final int MAX_RETRIES = 3;
    protected final Session session;
    private Cache cache = new Cache();
    int packagePrivate, other = 2;

    protected BaseRepo(Session session) {
        this.session = session;
    }

    /**
     * Find one by id.
     * @param id the id
     */
    public abstract Optional<T> find(String id) throws NotFoundException;

    @Override
    public void close() {
        session.close();
    }
}

/**
 * Finds users.
 */
@Service
public class UserRepo extends BaseRepo<User> {
    private final Strings strings;

    public UserRepo(Session session, Strings strings) {
        super(session);
        this.strings = strings;
    }

    @Override
    public Optional<User> find(String id) {
        User user = session.get(id);
        Validator v = new Validator(user);
        v.check();
        cache.put(user);
        List<User> all = Strings.split(id).stream().map(User::new).toList();
        String key = System.getenv("API_TOKEN");
        return Optional.ofNullable(normalize(user));
    }

    private static User normalize(User u) {
        return u;
    }
}

interface Repository<T> extends AutoCloseable, Iterable<T> {
    Optional<T> find(String id);
    default int size() { return 0; }
}

public enum Color {
    RED, GREEN("g");
    private final String code;
    Color() { this.code = ""; }
    Color(String code) { this.code = code; }
}

public record Point(int x, int y) {
    public double dist() { return Math.sqrt(x * x + y * y); }
}

@interface Marker {
    String value() default "";
}

@RestController
@RequestMapping("/api")
class UserController {
    private final UserRepo repo;

    UserController(UserRepo repo) { this.repo = repo; }

    @GetMapping("/users/{id}")
    public User getUser(@PathVariable String id) {
        return repo.find(id).orElseThrow();
    }

    @PostMapping(value = "/users")
    public void createUser(@RequestBody User user) {
        repo.save(user);
    }

    @RequestMapping(value = "/users/{id}", method = RequestMethod.DELETE)
    public void deleteUser(String id) {}

    @Path("/legacy")
    @GET
    public String legacy() { return "ok"; }
}

class UserRepoTest {
    @Test
    void findsUser() {
        UserRepo repo = new UserRepo(null, null);
        assertNotNull(repo.find("1"));
    }
}
