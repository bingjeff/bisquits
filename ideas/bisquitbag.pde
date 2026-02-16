class BisquitBag {
  char [] tiles;
  int [] index;
  int tilesout = 0;
  
  BisquitBag() {
    tiles = new char[] {
      'J','K','Q','X','Z',
      'J','K','Q','X','Z',
      'B','C','F','H','M','P','V','W','Y',
      'B','C','F','H','M','P','V','W','Y',
      'B','C','F','H','M','P','V','W','Y',
      'G','G','G','G',
      'L','L','L','L','L',
      'D','S','U','D','S','U',
      'D','S','U','D','S','U',
      'N','N','N','N','N','N','N','N',
      'T','R','T','R','T','R',
      'T','R','T','R','T','R',
      'T','R','T','R','T','R',
      'O','O','O','O','O','O',
      'O','O','O','O','O',
      'I','I','I','I','I','I',
      'I','I','I','I','I','I',
      'A','A','A','A','A','A','A',
      'A','A','A','A','A','A',
      'E','E','E','E','E','E',
      'E','E','E','E','E','E',
      'E','E','E','E','E','E' };
    index = new int[tiles.length];
    for(int c=0; c<tiles.length; c++) {
      index[c] = c;
    }
    mix();
  }
  // Shuffle the index using the Fisher-Yates algorithm
  void mix() {
    int idx, temp;
    for(int c=(index.length-1); c>0; c--) {
      idx = int(random(c));
      temp = index[idx];
      index[idx] = index[c];
      index[c] = temp;
    }
  }
  // Draw tiles from bag and send them back
  char[] pop(int numtiles) {
    char[] poppedtiles = null;
    //println("pop");
    if( (numtiles+tilesout) < index.length ) {
      poppedtiles = new char[numtiles];
      //println("Num tiles:" + str(poppedtiles.length));
      for(int c=0; c<numtiles; c++) {
        //println("O:"+str(tilesout));
        //println("I:"+str(index[tilesout]));
        //println("T:"+str(tiles.length));
        poppedtiles[c] = tiles[index[tilesout]];
        //println("Popped tiles:" + str(poppedtiles[c]));
        tilesout++;
      }
    }
    //println("All popped tiles:" + new String(poppedtiles));
    return poppedtiles;
  }
  // Push a tile back into the bag
  void push(char pushedtile) {
    int idx,temp;
    // Try and put the tile back
    for(int c=0; c<tilesout; c++) {
      if(tiles[index[c]]==pushedtile) {
        tilesout--;
        temp = index[c];
        index[c] = index[tilesout];
        index[tilesout] = temp;
        break;
      }
    }
    // Shuffle the location of the replaced tile
    idx = int(random(tilesout,(index.length)-1));
    temp = index[idx];
    index[idx] = index[tilesout];
    index[tilesout] = temp;
  }
  // Discard a tile and get three back
  char[] discard(char discardedtile) {
    char [] newtiles;
    newtiles = pop(3);
    if(newtiles.length > 0) {
      push(discardedtile);
    }
    return newtiles;
  }
  // Get the number of tiles left
  int numTilesRemaining() {
    return index.length - tilesout;
  }
}
