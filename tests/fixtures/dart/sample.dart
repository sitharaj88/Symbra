import 'package:flutter/material.dart';
import 'package:myapp/models/user.dart' as models show User, Session hide Foo;
import 'utils.dart';
import '../core/base.dart';
export 'src/widgets.dart';
part 'sample.g.dart';

/// Base repository.
abstract class BaseRepo<T> implements Disposable {
  void load();
}

mixin Loggable {
  void log(String m) {}
}

/// User repository.
class UserRepo extends BaseRepo<User> with Loggable implements Repo, Other {
  final Session session;
  String? _name;
  static const int MAX = 3;
  List<User> users = [];

  UserRepo(this.session);
  UserRepo.named(this.session) : super();
  factory UserRepo.create() => UserRepo(Session());

  int get count => users.length;
  set name(String v) => _name = v;

  @override
  void load() {
    final u = User(id: 1);
    var s = Session.open('x');
    session.get('url', retries: 2);
    _helper(u);
    models.User.fromJson({});
    final token = Platform.environment['API_TOKEN'];
    print(token);
  }

  Future<User?> find(int id) async => users.first;
  void _helper(User u) {}
}

enum Status { active, inactive, pending }

extension UserExt on User {
  String greet() => 'hi';
}

typedef Callback = void Function(int);
typedef OldCb(int x);

const int GLOBAL_MAX = 5;
final config = Config();
var counter = 0;

Future<void> topLevel(UserRepo repo, {int retries = 1}) async {
  await repo.find(1);
  topLevel2();
}

void main() {
  group('UserRepo', () {
    test('finds user', () {
      final r = UserRepo(Session());
      expect(r.find(1), isNotNull);
    });
  });
}
