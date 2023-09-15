#!/bin/bash

list=$(ls ./*.md; ls ./past/*.md)
for file in $list ; do
  date=$(date -r ${file} +%D)
  file=${file:2}
  file=${file%.*}
  echo "$file"
  target=${file}.html
  cat head.htm_ > ${target}
  cmark --unsafe ${file}.md >> ${target}
  cat foot.htm_ >> ${target}
  sed -i.raw 's|DATE|'$date'|g' ${target}
done

# news
news=$(ls news -Art | tail -n 1)
newsdate=$(date -r news/${news} +%D)
cmark --unsafe news/${news} > news.htm_
sed -i.raw -e '/NEWS/r news.htm_' -e 'x;$G' index.html

# old news and rss
list=$(ls -r ./news/*.md)
cat head.htm_ > old.html
cat start_rss.xml_ > rss.xml
for file in $list ; do
  # old.html
  cmark --unsafe ${file} >> old.html
  echo "<br/><br/>" >> old.html
  # rss
  echo "<item>" >> rss.xml
  echo "<title>monome</title>" >> rss.xml
  echo "<link>https://monome.org/old.html</link>" >> rss.xml
  echo "<guid>$file</guid>" >> rss.xml
  echo "<description><![CDATA[" >> rss.xml
  cmark ${file} >> rss.xml
  echo "]]></description>" >> rss.xml
  date=$(date -r $file "+%a, %d %b %Y 11:11:11 EST")
  echo "<pubDate>$date</pubDate>" >> rss.xml 
  echo "</item>" >> rss.xml
done
cat foot.htm_ >> old.html
cat end_rss.xml_ >> rss.xml
sed -i.raw 's|DATE|'$newsdate'|g' old.html


# payment links
sed -i.raw -e '/ZERO/r zero.htm_' -e '/ONE/r one.htm_' -e '/BSTOCK/r one-b.htm_' -e '/NORNS/r norns.htm_' -e '/CROW/r crow.htm_' -e 'x;$G' index.html


# cleanup
rm *.raw
rm past/*.raw
