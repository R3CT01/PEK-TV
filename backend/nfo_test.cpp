// g++ -std=c++17 -o /tmp/nfo_test nfo_test.cpp && /tmp/nfo_test
#include "nfo.h"
#include <cstdio>
static int fails = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL line %d: %s\n", __LINE__, #c); ++fails; } } while (0)

int main() {
    auto m = nfo::parse("\xEF\xBB\xBF<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        "<movie>\n <title>Amélie &amp; Co</title>\n <originaltitle>Le Fabuleux Destin</originaltitle>\n"
        " <year>2001</year>\n <plot><![CDATA[A shy waitress <3 changes lives.]]></plot>\n"
        " <actor><name>Audrey</name><title>Not this</title></actor>\n <set><name>X</name></set>\n</movie>");
    CHECK(m.ok); CHECK(m.root == "movie"); CHECK(m.title == "Amélie & Co"); CHECK(m.year == 2001);
    CHECK(m.plot == "A shy waitress <3 changes lives."); CHECK(m.originaltitle == "Le Fabuleux Destin");

    auto m2 = nfo::parse("<movie><title>Heat</title><premiered>1995-12-15</premiered><outline>Cops &#38; robbers &#x41;</outline></movie>");
    CHECK(m2.ok && m2.year == 1995 && m2.plot == "Cops & robbers A");

    auto e = nfo::parse("<episodedetails><title>Pilot</title><showtitle>Friends</showtitle><season>1</season><episode>1</episode>"
                        "<plot>Ross.</plot></episodedetails>\n<episodedetails><title>Second</title><episode>2</episode></episodedetails>");
    CHECK(e.ok && e.root == "episodedetails" && e.showtitle == "Friends" && e.season == 1 && e.episode == 1 && e.title == "Pilot");

    auto t = nfo::parse("<!-- c --><tvshow><title>Seinfeld</title><year>1989</year><plot>Nothing.</plot><episodeguide><url>x</url></episodeguide></tvshow>");
    CHECK(t.ok && t.root == "tvshow" && t.title == "Seinfeld" && t.year == 1989);

    CHECK(!nfo::parse("https://www.themoviedb.org/movie/603").ok);          // link-only nfo
    CHECK(!nfo::parse("<html><title>x</title></html>").ok);                  // other xml
    CHECK(!nfo::parse("").ok);
    CHECK(!nfo::parse("<movie><title>Broken").title.size());                 // truncated, no crash
    auto sc = nfo::parse("<movie><title/><plot>ok</plot></movie>");
    CHECK(sc.ok && sc.title.empty() && sc.plot == "ok");
    std::printf(fails ? "%d FAILED\n" : "all nfo tests passed\n", fails);
    return fails ? 1 : 0;
}
