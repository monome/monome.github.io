#!/bin/bash

date=$(date -r index.htm_ +%D)
sed  -e '/GRID/r grid.htm_' -e '/NORNS/r norns.htm_' -e 'x;$G' index.htm_ > index.html
sed -i 's|DATE|'$date'|g' index.html

