#import "BaseRepo.h"
#import <Foundation/Foundation.h>
@import CoreData;

/// A repository protocol.
@protocol Repo <NSObject>
- (nullable id)find:(NSInteger)ident;
@end

typedef NS_ENUM(NSInteger, Status) {
    StatusActive = 0,
    StatusInactive,
    StatusPending
};

static NSString *const kDefaultName = @"anon";

/// User repository.
@interface UserRepo : BaseRepo <Repo, NSCopying> {
    NSInteger _hits;
}
/// The display name.
@property (nonatomic, strong) NSString *name;
- (instancetype)initWithSession:(Session *)session;
- (User *)find:(NSInteger)ident other:(NSString *)b;
+ (void)reset;
@end

@interface UserRepo (Extra)
- (void)extra;
@end

@implementation UserRepo

- (User *)find:(NSInteger)ident other:(NSString *)b {
    Session *s = self.session;
    User *u = [[User alloc] initWithName:kDefaultName];
    [s get:ident with:b];
    NSLog(@"looked up %@", b);
    const char *tok = getenv("API_TOKEN");
    NSDictionary *env = [[NSProcessInfo processInfo] environment];
    NSString *home = env[@"HOME"];
    [self reload];
    return u;
}

+ (void)reset {
    UserRepo *fresh = [UserRepo new];
    (void)fresh;
}

@end

@implementation UserRepo (Extra)
- (void)extra { }
@end

void helperFunction(NSString *arg) {
    NSLog(@"%@", arg);
}

@interface UserRepoTests : XCTestCase
@end

@implementation UserRepoTests
- (void)testFind {
    UserRepo *repo = [[UserRepo alloc] initWithSession:nil];
    [repo find:1 other:@"x"];
}
@end
