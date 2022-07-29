#!/bin/bash

sed  -e '/GRID/r grid.htm_' -e '/NORNS/r norns.htm_' -e 'x;$G' index.htm_ > index.html

