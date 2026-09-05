#include "sample.h"
#include <stdlib.h>

int counter = 0;
static int hidden = 1;
const char *NAME = "sample";

/** Adds two numbers. */
int add(int a, int b) { return a + b; }

// Makes a point.
struct point *make_point(int x, int y) {
    struct point *p = malloc(sizeof(struct point));
    point_t local;
    p->x = x;
    p->y = SQUARE(y);
    return p;
}

static void process(struct point *pt, callback_fn cb) {
    const char *home = getenv("HOME");
    int r = add(pt->x, pt->y);
    cb(r);
    pt->print(pt);
    local.reset();
}

int (*get_handler(void))(int) { return 0; }

int main(int argc, char **argv) {
    struct point *p = make_point(1, 2);
    process(p, 0);
    free(p);
    return 0;
}
