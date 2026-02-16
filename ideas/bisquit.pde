class Bisquit {
  String tile;
  int b_size;
  int row, col, x, y;
  boolean isdropped;
  
  Bisquit(char[] letter) {
    b_size = 20;
    tile = new String(letter);
    row = 1;
    col = 1;
    x = b_size;
    y = b_size;
    isdropped = false;
  }
  
  void render() {
    if(isdropped) {
      dropping();
    }
    //Draw tile
  rectMode(RADIUS);
  fill(200);
  stroke(20);
  strokeWeight(3);
  rect(x,y,b_size,b_size,0.4*b_size);
  //Draw letter
  textAlign(CENTER,CENTER);
  fill(20);
  noStroke();
  text(tile,x,y);
  }
  
  boolean isHit(int tx, int ty) {
    if( (tx > x-b_size) && (tx < x+b_size) &&
    (ty > y-b_size) && (ty < y+b_size) ) {
      return true;
    }
    return false;
  }
  
  boolean isHit() {
    return isHit(mouseX,mouseY);
  }
  
  void move(int newx, int newy) {
    x = newx;
    y = newy;
  }
  
  void dropping() {
    int finalx = 2*col*b_size - b_size;
    int finaly = 2*row*b_size - b_size;
    int deltax = x-finalx;
    int deltay = y-finaly;
    int ismoving = 0;
    if(abs(deltax)>b_size) {
      deltax *= 0.3;
      ismoving++;
    }
    if(abs(deltay)>b_size) {
      deltay *= 0.3;
      ismoving++;
    }
    move(x-deltax,y-deltay);
    if(ismoving==0) {
      isdropped = false;
    }
  }
  
  void updateGrid() {
    row = round( 0.5*(y-b_size)/b_size ) + 1;
    col = round( 0.5*(x-b_size)/b_size ) + 1;
  }
}
