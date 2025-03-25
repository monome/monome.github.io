# set file modification dates to entry date

list=$(ls -r ./news/*.md)

for file in $list ; do
  file=${file:2}
  subfile=${file%.*}
  name=${subfile#*\/}
  name=${name:0:6}
  echo "$file / $name"
  touch -d $name $file
done



