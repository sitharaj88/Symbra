#include "sample.hpp"
#include <cstdlib>
#include <gtest/gtest.h>

using namespace acme::db;
using std::string;

namespace acme::db {

Repo::Repo(const std::string& name) : name_(name) {}
Repo::~Repo() {}

/// Saves a user.
void Repo::save(const User& u) {
    auto c = std::make_unique<Cache>();
    Cache local{};
    Cache* raw = new Cache();
    Session sess(name_);
    User copy = User(u);
    c->warm();
    local.clear();
    raw->flush();
    sess.open();
    cache_->store(u);
    const char* home = std::getenv("HOME");
    auto n = count();
    acme::util::log(name_);
    helper<int>(3);
    delete raw;
}

int Repo::count() { return 0; }

static void helper2() {}

int globalCounter = 0;
const int kLimit = 5;

} // namespace

TEST(RepoTest, SavesUser) {
    Repo* r = nullptr;
    EXPECT_EQ(Repo::count(), 0);
}

TEST_F(RepoFixture, Finds) {
    find(1);
}

TEST_CASE("repo counts") {
    REQUIRE(Repo::count() == 0);
}

int main() {
    auto lam = [](int x) { return x; };
    return lam(0);
}
