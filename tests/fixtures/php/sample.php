<?php
/**
 * Sample PHP file for extractor tests.
 */
declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use App\Models\Post as P;
use App\Contracts\{Repo, Cache as C};
use function App\Helpers\fmt;
use Symfony\Component\Routing\Attribute\Route;

require_once __DIR__ . '/helpers.php';
include 'legacy.php';

const VERSION = '1.0';

/**
 * Service for users.
 *
 * @package App
 */
abstract class UserService extends BaseService implements Repo, \Countable
{
    use HasTimestamps, Loggable;

    public const MAX = 10;
    private const MIN = 1;
    private Repo $repo;
    protected ?User $user = null;
    public static int $count = 0;

    public function __construct(private C $cache, protected readonly Logger $log, string $name)
    {
        $this->repo = new UserRepo();
        $u = new User();
        $u->save();
        $this->cache->get('x');
        self::helper();
        static::create();
        parent::__construct();
        User::find(1);
        \App\Models\User::all();
        fmt($name);
        $x = getenv('HOME');
        $y = $_ENV['DB_HOST'];
        $z = env('APP_KEY', 'd');
        if ($u instanceof P) {}
        $c = new static();
        $e = new \App\Models\Post();
        $found = User::find(2);
    }

    /** Find one. */
    public static function find(int $id, ?P $p = null): ?User
    {
        return null;
    }

    abstract protected function helper(): void;

    final public function count(): int { return 0; }

    private function hidden(): void {}
}

interface Repo extends \Countable, Base
{
    public function all(): array;
}

trait Loggable
{
    public function log(string $m): void {}
}

enum Status: string
{
    case Active = 'a';
    case Inactive = 'i';
    public function label(): string { return 'x'; }
}

function helper(User $u, $x): string
{
    return $u->name;
}

#[Route('/users')]
#[Deprecated]
class UserController
{
    #[Route('/{id}', name: 'show', methods: ['GET', 'HEAD'])]
    public function show(int $id): Response { return new Response(); }
}

Route::get('/api/users', [UserController::class, 'show']);
Route::post('/api/users', 'UserController@store');
Route::get('/closure', function () { return 1; });

class FooTest extends TestCase
{
    /**
     * @test
     */
    public function itWorks(): void {}

    public function testBar(): void { Route::get('/in/test', 'X@y'); }

    public function helperNotTest(): void {}
}
