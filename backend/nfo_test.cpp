// g++ -std=c++17 -o /tmp/nfo_test nfo_test.cpp && /tmp/nfo_test
#include "nfo.h"
#include <cstdio>
#include <string>
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

    // people / genres / rating (search and browse)
    auto r = nfo::parse("<movie><title>Heat</title><year>1995</year><genre>Crime / Drama</genre><genre>Thriller</genre><genre>drama</genre>"
        "<director>Michael Mann</director><studio>Warner Bros.</studio><mpaa>Rated R</mpaa><runtime>170</runtime>"
        "<ratings><rating name=\"imdb\" max=\"10\"><value>8.3</value><votes>1</votes></rating></ratings>"
        "<set><name>Mann Collection</name><overview>x</overview></set>"
        "<actor><name>Al Pacino</name><role>Vincent Hanna</role><order>0</order></actor>"
        "<actor><name>Robert &amp; De Niro</name><role><![CDATA[Neil McCauley]]></role></actor><actor><role>no name</role></actor></movie>");
    CHECK(r.ok && r.title == "Heat");
    CHECK(r.genres.size() == 3 && r.genres[0] == "Crime" && r.genres[1] == "Drama" && r.genres[2] == "Thriller");   // split, de-duplicated
    CHECK(r.directors.size() == 1 && r.directors[0] == "Michael Mann");
    CHECK(r.studios.size() == 1 && r.studios[0] == "Warner Bros.");
    CHECK(r.mpaa == "Rated R" && r.runtime == 170 && r.rating > 8.29 && r.rating < 8.31);
    CHECK(r.collection == "Mann Collection");
    CHECK(r.actors.size() == 2 && r.actors[0].name == "Al Pacino" && r.actors[0].role == "Vincent Hanna");
    CHECK(r.actors[1].name == "Robert & De Niro" && r.actors[1].role == "Neil McCauley");
    auto r2 = nfo::parse("<movie><title>Old</title><rating>7.25</rating><actor><name>A</name></actor></movie>");   // the older Kodi layout
    CHECK(r2.rating > 7.2 && r2.rating < 7.3 && r2.actors.size() == 1 && r2.actors[0].role.empty());
    CHECK(nfo::parse("<movie><title>X</title><rating>99</rating></movie>").rating == 0);                            // out of range: ignored
    CHECK(nfo::parse("<tvshow><title>S</title><genre>Sci-Fi &amp; Fantasy</genre></tvshow>").genres[0] == "Sci-Fi & Fantasy");
    {   // a hostile file with thousands of actors stays small
        std::string big = "<movie><title>B</title>";
        for (int i = 0; i < 5000; ++i) big += "<actor><name>N" + std::to_string(i) + "</name></actor>";
        big += "</movie>";
        CHECK(nfo::parse(big).actors.size() == 60);
    }

    CHECK(!nfo::parse("https://www.themoviedb.org/movie/603").ok);          // link-only nfo
    CHECK(!nfo::parse("<html><title>x</title></html>").ok);                  // other xml
    CHECK(!nfo::parse("").ok);
    CHECK(!nfo::parse("<movie><title>Broken").title.size());                 // truncated, no crash
    auto sc = nfo::parse("<movie><title/><plot>ok</plot></movie>");
    CHECK(sc.ok && sc.title.empty() && sc.plot == "ok");
    std::printf(fails ? "%d FAILED\n" : "all nfo tests passed\n", fails);
    return fails ? 1 : 0;
}
