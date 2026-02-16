BisquitBag bag;
ArrayList letters;
boolean isselected, gameison;
int sel, b_size, h_button, ncol, nrow, nplayers;

void setup() {
  frameRate(30);
  bag = new BisquitBag();
  letters = new ArrayList();
  isselected = false;
  gameison = true;
  sel = 0;
  b_size = 20;
  h_button = 4*b_size;
  ncol = 12;
  nrow = 12;
  nplayers = 5;

  reset();
//  size(2*b_size*ncol, 2*b_size*nrow+h_button);
  size(480, 640);
  textFont(createFont("Helvetica-Bold", 32));
  //Determine system fonts:
  //String[] fontList = PFont.list();
  //println(fontList);
}

void reset() {
  bag.tilesout = 0;
  bag.mix();
  letters.clear();
  for (int c=0; c<12; c++) {
    newLetter();
    bag.pop(nplayers-1);
  }
}

void draw() {
  if ( gameison ) {
    background(120);
    renderDropArea();
    for (int c=0; c<letters.size(); c++) {
      ((Bisquit)letters.get(c)).render();
    }
    if ( isselected ) {
      ((Bisquit)letters.get(sel)).render();
    }
    if (frameCount % round((frameRate*random(5, 20))) == 0 ) {
      if (bag.numTilesRemaining()>nplayers) {
        bag.pop(nplayers-1);
        newLetter();
      } 
      else {
        rectMode(CORNER);
        noStroke();
        fill(200,100,100,100);
        rect(0,0,width,height);
        fill(0);
        textAlign(CENTER,CENTER);
        text("You lost. :(",0.5*width,0.5*width);
        gameison = false;
      }
    }
  }
}

void mousePressed() {
  if( gameison ) {
  for (int c=0; c<letters.size(); c++) {
    if ( ((Bisquit)letters.get(c)).isHit() ) {
      isselected = true;
      sel = c;
    }
   }
  } else {
    reset();
    gameison = true;
  }
}

void mouseDragged() {
  if ( isselected) {
    Bisquit letter = (Bisquit)letters.get(sel);
    int x = letter.x;
    int y = letter.y;
    if (mouseX>b_size && mouseX<(width-b_size)) {
      x = mouseX;
    }
    if (mouseY>b_size && mouseY<(height-b_size)) {
      y = mouseY;
    }
    letter.move(x, y);
  }
}

void mouseReleased() {
  if ( mouseY>(height-h_button) ) {
    if ( isselected && (bag.numTilesRemaining()>3) ) {
      bag.push( ((Bisquit)letters.get(sel)).tile.charAt(0) );
      letters.remove(sel);
      newLetter();
      newLetter();
      newLetter();
    } 
    else {
      if (bag.numTilesRemaining()>nplayers) {
        bag.pop(nplayers-1);
        newLetter();
      } 
      else {
        rectMode(CORNER);
        noStroke();
        fill(100,200,100,100);
        rect(0,0,width,height);
        fill(0);
        textAlign(CENTER,CENTER);
        text("You won! :)",0.5*width,0.5*width);
        gameison = false;
      }
    }
  } 
  else {
    if ( isselected ) {
      Bisquit letter = (Bisquit)letters.get(sel);
      Bisquit letterswap;
      int swp=-1;
      for (int c=0; c<letters.size(); c++) {
        if ( c!=sel && ((Bisquit)letters.get(c)).isHit() ) {
          swp = c;
          break;
        }
      }
      if (swp>-1) {
        letterswap = (Bisquit)letters.get(swp);
        letterswap.row = letter.row;
        letterswap.col = letter.col;
        letterswap.isdropped = true;
      }
      letter.updateGrid();
      letter.isdropped = true;
    }
  }
  isselected = false;
}

void newLetter() {
  int x=b_size;
  int y=b_size;
  int r=1;
  int c=0;
  boolean ishit = true;
  Bisquit letter;
  while (ishit && r<nrow) {
    c++;
    if (c>ncol) {
      c=1;
      r++;
    }
    ishit = false;
    for (int i=0; i<letters.size(); i++) {
      if ( ((Bisquit)letters.get(i)).row == r 
        && ((Bisquit)letters.get(i)).col == c ) {
        ishit = true;
        break;
      }
    }
  }
  letter = new Bisquit(bag.pop(1));
  letter.col = c;
  letter.row = r;
  letter.isdropped = true;
  letters.add( letter );
}

void renderDropArea() {
  int r = 100;
  int g = 100;
  int b = 150;
  int d = 15;
  float remainder = ((float)bag.numTilesRemaining())/((float)bag.index.length);
  String msg = "More ingredients!";

  if ( bag.numTilesRemaining() <= nplayers ) {
    msg = "Next click wins!";
    r = 180;
    g = 180;
    b = 50;
  }

  if ( mouseY>(height-h_button) ) {
    if ( isselected ) {
      if (bag.numTilesRemaining() > 3) {
        msg = "Trade one for three.";
        r = 100;
        g = 180;
        b = 100;
        d = 80;
      } 
      else {
        msg = "Not enough tiles to trade!";
        r = 180;
        g = 100;
        b = 100;
        d = 80;
      }
    } 
    else {
      if ( mousePressed ) {
        r += 50;
        g += 50;
        b += 50;
      } 
      else {
        d = 50;
      }
    }
  }

  //Render the area
  fill(r, g, b);
  noStroke();
  rectMode(CORNER);
  rect(0, height-h_button, width, h_button);
  //Render text
  textAlign(CENTER, CENTER);
  fill(r-d, g-d, b-d);
  text(msg, 0.5*width, height - 2*b_size);
  //Render the progress meter

  strokeCap(SQUARE);
  strokeWeight(10);
  stroke(r-15, g-15, b-15);
  line(0, height-h_button+5, width, height-h_button+5);
  stroke(200);
  line(0, height-h_button+5, int(remainder*width), height-h_button+5);
}

