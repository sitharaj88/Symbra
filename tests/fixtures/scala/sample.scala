/**
 * Sample Scala file for extractor tests.
 */
package com.acme.users

import java.util.Optional
import com.acme.util.Strings
import com.acme.util._
import com.acme.util.{Formatter => Fmt, Parser}
import scala.collection.mutable

/** Base repository. */
abstract class BaseRepo[T](protected val session: Session) extends Repository[T] with Closeable {
  private val cache: Cache = new Cache()
  val MAX_RETRIES = 3

  /** Find one by id. */
  def find(id: String): Option[T]

  override def close(): Unit = session.close()
}

/** Finds users. */
class UserRepo(session: Session, strings: Strings) extends BaseRepo[User](session) {
  var count: Int = 0

  override def find(id: String): Option[User] = {
    val user = session.get(id)
    val v = new Validator(user)
    v.check()
    cache.put(user)
    val fmt: Fmt = Fmt()
    val key = System.getenv("API_TOKEN")
    Option(normalize(user))
  }

  private def normalize(u: User): User = u
}

trait Repository[T] extends AutoCloseable {
  def find(id: String): Option[T]
}

case class User(id: String, name: String)

object Registry extends Repository[User] {
  def find(id: String): Option[User] = None
  def lookup(id: String): User = users(id)
  val users = mutable.Map.empty[String, User]
}

type Handler = String => Unit

class UserRepoSpec extends AnyFunSuite {
  test("finds user") {
    val repo = new UserRepo(null, null)
    assert(repo.find("1").isEmpty)
  }
}

class UserRepoWordSpec extends AnyWordSpec {
  "UserRepo" should {
    "find users" in {
      val repo = new UserRepo(null, null)
      repo.find("1")
    }
  }
  it("also works") {
    Registry.lookup("x")
  }
}
