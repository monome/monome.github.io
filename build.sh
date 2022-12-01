#!/bin/bash

list=$(ls -r ./*.md)
for file in $list ; do
  date=$(date -r ${file} +%D)
  file=${file:2}
  file=${file%.*}
  echo "$file"
  target=${file}.html
  cat head.htm_ > ${target}
  cmark --unsafe ${file}.md >> ${target}
  cat foot.htm_ >> ${target}
  sed -i 's|DATE|'$date'|g' ${target}
done

sed -i -e '/GRID/r grid.htm_' -e '/NORNS/r norns.htm_' -e 'x;$G' index.html
